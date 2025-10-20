/**
 * Solana Actions API: Batch Execution Plan
 * Returns DAG (Directed Acyclic Graph) execution plan with topological order
 * Phase 3: Batch Execution (Optimistic)
 */
import { NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@/lib/logger'
import { jobQueue } from '@/services/queue/job-queue'
import type { QueuedJob } from '@/types/queue'

const log = createLogger('API:BatchPlan')

function setCors(res: NextResponse) {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Encoding, Accept-Encoding')
  return res
}

export async function OPTIONS() {
  return setCors(new NextResponse(null, { status: 200 }))
}

interface DAGNode {
  id: number
  job_pda: string
  job_id: string  // For compatibility, same as job_pda
  cid_handles: string[]
  ir_digest: string
  commitment: string
  output_handle?: string
  depends_on: number[]
  slot: number
  status: string
}

interface DAGEdge {
  from: number
  to: number
}

/**
 * Build DAG from actual JobQueue jobs
 *
 * Current implementation: Simple sequential execution (no dependencies)
 * Future: Parse IR to detect actual data dependencies
 */
function buildDAGFromJobs(jobs: QueuedJob[]): { nodes: DAGNode[], edges: DAGEdge[] } {
  const nodes: DAGNode[] = []
  const edges: DAGEdge[] = []

  // Sort jobs by slot (submission order)
  const sortedJobs = [...jobs].sort((a, b) => a.slot - b.slot)

  // Convert jobs to DAG nodes
  sortedJobs.forEach((job, index) => {
    nodes.push({
      id: index,
      job_pda: job.job_pda,
      job_id: job.job_pda,  // Use job_pda as identifier
      cid_handles: job.cid_handles,
      ir_digest: job.ir_digest,
      commitment: job.commitment,
      output_handle: `output_${job.job_pda.slice(0, 16)}`,  // Mock output handle
      depends_on: [],  // No dependencies in simple mode
      slot: job.slot,
      status: job.status,
    })
  })

  // TODO: Analyze IR to build actual dependency graph
  // For now, all jobs are independent (can execute in parallel)

  return { nodes, edges }
}

/**
 * Compute topological order (Kahn's algorithm)
 * Prioritizes decrypt-needed nodes (nodes with no dependencies)
 */
function topologicalSort(nodes: DAGNode[], edges: DAGEdge[]): number[] {
  const inDegree = new Map<number, number>()
  const adjList = new Map<number, number[]>()

  // Initialize
  for (const node of nodes) {
    inDegree.set(node.id, 0)
    adjList.set(node.id, [])
  }

  // Build adjacency list and in-degree
  for (const edge of edges) {
    adjList.get(edge.from)!.push(edge.to)
    inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1)
  }

  // Queue nodes with in-degree 0 (decrypt-needed first)
  const queue: number[] = []
  const order: number[] = []

  for (const [nodeId, degree] of inDegree.entries()) {
    if (degree === 0) queue.push(nodeId)
  }

  // Process queue
  while (queue.length > 0) {
    const current = queue.shift()!
    order.push(current)

    for (const neighbor of adjList.get(current) || []) {
      const newDegree = inDegree.get(neighbor)! - 1
      inDegree.set(neighbor, newDegree)
      if (newDegree === 0) queue.push(neighbor)
    }
  }

  if (order.length !== nodes.length) {
    throw new Error('Cycle detected in DAG')
  }

  return order
}

/**
 * Generate decrypt-needed bitmap
 * Bit i = 1 if node i needs decryption (i.e., has no dependencies)
 */
function generateDecryptNeededBitmap(nodes: DAGNode[]): string {
  let bitmap = 0
  for (const node of nodes) {
    if (node.depends_on.length === 0) {
      bitmap |= (1 << node.id)
    }
  }
  return `0x${bitmap.toString(16).padStart(2, '0')}`
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const windowParam = searchParams.get('window')
    const batchParam = searchParams.get('batch')

    let jobs: QueuedJob[] = []
    let window_start_slot = 0
    let window_end_slot = 0

    // Get jobs by batch PDA or slot window
    if (batchParam) {
      // Get jobs for specific batch
      jobs = jobQueue.get_jobs_by_batch(batchParam)

      if (jobs.length > 0) {
        window_start_slot = Math.min(...jobs.map(j => j.slot))
        window_end_slot = Math.max(...jobs.map(j => j.slot))
      }

      log.info('Fetching DAG for batch', {
        batch: batchParam.slice(0, 8) + '...',
        jobs: jobs.length
      })
    } else if (windowParam) {
      // Get jobs by slot range (window_start -> window_start + 100)
      window_start_slot = parseInt(windowParam, 10)
      window_end_slot = window_start_slot + 100

      jobs = jobQueue.get_jobs_by_slot_range(window_start_slot, window_end_slot)

      log.info('Fetching DAG for slot window', {
        start: window_start_slot,
        end: window_end_slot,
        jobs: jobs.length
      })
    } else {
      // Default: Get all queued jobs
      jobs = jobQueue.get_queued_jobs()

      if (jobs.length > 0) {
        window_start_slot = Math.min(...jobs.map(j => j.slot))
        window_end_slot = Math.max(...jobs.map(j => j.slot))
      }

      log.info('Fetching DAG for all queued jobs', { jobs: jobs.length })
    }

    if (jobs.length === 0) {
      return setCors(NextResponse.json({
        type: 'batch-plan',
        window_start_slot,
        window_end_slot,
        dag: {
          nodes: [],
          edges: [],
        },
        topo_order: [],
        decrypt_needed_bitmap: '0x00',
        queue_stats: jobQueue.get_stats(),
        message: 'No jobs in queue. Submit jobs first via /api/actions/job/submit',
        hint: 'Jobs are only enqueued after on-chain confirmation (JobSubmitted event)',
      }))
    }

    // Build DAG from real jobs
    const { nodes, edges } = buildDAGFromJobs(jobs)

    // Compute topological order
    const topo_order = topologicalSort(nodes, edges)

    // Generate decrypt-needed bitmap
    const decrypt_needed_bitmap = generateDecryptNeededBitmap(nodes)

    const queueStats = jobQueue.get_stats()

    return setCors(NextResponse.json({
      type: 'batch-plan',
      window_start_slot,
      window_end_slot,
      dag: {
        nodes: nodes.map(n => ({
          id: n.id,
          job_pda: n.job_pda,
          job_id: n.job_id,
          cid_handles: n.cid_handles,
          ir_digest: n.ir_digest.slice(0, 16) + '...',  // Truncate for display
          commitment: n.commitment.slice(0, 16) + '...',
          output_handle: n.output_handle,
          slot: n.slot,
          status: n.status,
        })),
        edges,
      },
      topo_order,
      decrypt_needed_bitmap,
      queue_stats: {
        total_jobs: queueStats.total_jobs,
        queued: queueStats.queued_count,
        executing: queueStats.executing_count,
        completed: queueStats.completed_count,
      },
      execution_hints: {
        description: 'Execute nodes in topological order',
        decrypt_priority: 'All nodes currently need decryption (no dependencies)',
        parallelism: 'All jobs can execute in parallel (no inter-job dependencies)',
        note: 'Dependency analysis requires IR parsing (future work)',
      },
      data_source: 'real_job_queue',
    }))
  } catch (e: unknown) {
    log.error('Batch plan error', e)
    return setCors(NextResponse.json({
      message: e instanceof Error ? e.message : 'Internal server error',
      details: e instanceof Error ? e.stack : String(e)
    }, { status: 500 }))
  }
}
