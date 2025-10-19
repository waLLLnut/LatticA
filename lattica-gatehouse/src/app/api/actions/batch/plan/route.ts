/**
 * Solana Actions API: Batch Execution Plan
 * Returns DAG (Directed Acyclic Graph) execution plan with topological order
 * Phase 3: Batch Execution (Optimistic)
 */
import { NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@/lib/logger'
import crypto from 'crypto'

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
  job_id: string
  cid_handles: string[]
  output_handle?: string
  depends_on: number[]
}

interface DAGEdge {
  from: number
  to: number
}

/**
 * Generate dummy DAG for demo
 * In production, this would query actual submitted jobs and build dependency graph
 */
function generateDemoDAG() {
  const nodes: DAGNode[] = []
  const edges: DAGEdge[] = []

  // Node 0: Input job (decrypt needed)
  nodes.push({
    id: 0,
    job_id: crypto.randomBytes(16).toString('hex'),
    cid_handles: [
      `CID${crypto.randomBytes(8).toString('hex')}`,
      `CID${crypto.randomBytes(8).toString('hex')}`,
    ],
    output_handle: crypto.randomBytes(16).toString('hex'),
    depends_on: [],
  })

  // Node 1: Input job (decrypt needed)
  nodes.push({
    id: 1,
    job_id: crypto.randomBytes(16).toString('hex'),
    cid_handles: [
      `CID${crypto.randomBytes(8).toString('hex')}`,
    ],
    output_handle: crypto.randomBytes(16).toString('hex'),
    depends_on: [],
  })

  // Node 2: Depends on node 0
  const node2Output = crypto.randomBytes(16).toString('hex')
  nodes.push({
    id: 2,
    job_id: crypto.randomBytes(16).toString('hex'),
    cid_handles: [nodes[0].output_handle!],
    output_handle: node2Output,
    depends_on: [0],
  })
  edges.push({ from: 0, to: 2 })

  // Node 3: Depends on node 1
  const node3Output = crypto.randomBytes(16).toString('hex')
  nodes.push({
    id: 3,
    job_id: crypto.randomBytes(16).toString('hex'),
    cid_handles: [nodes[1].output_handle!],
    output_handle: node3Output,
    depends_on: [1],
  })
  edges.push({ from: 1, to: 3 })

  // Node 4: Depends on nodes 2 and 3
  nodes.push({
    id: 4,
    job_id: crypto.randomBytes(16).toString('hex'),
    cid_handles: [node2Output, node3Output],
    output_handle: crypto.randomBytes(16).toString('hex'),
    depends_on: [2, 3],
  })
  edges.push({ from: 2, to: 4 })
  edges.push({ from: 3, to: 4 })

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
    const window = parseInt(searchParams.get('window') || '1000', 10)

    // Generate DAG
    const { nodes, edges } = generateDemoDAG()

    // Compute topological order
    const topo_order = topologicalSort(nodes, edges)

    // Generate decrypt-needed bitmap
    const decrypt_needed_bitmap = generateDecryptNeededBitmap(nodes)

    return setCors(NextResponse.json({
      type: 'batch-plan',
      window_start_slot: window,
      dag: {
        nodes: nodes.map(n => ({
          id: n.id,
          job_id: n.job_id,
          cid_handles: n.cid_handles,
          output_handle: n.output_handle,
        })),
        edges,
      },
      topo_order,
      decrypt_needed_bitmap,
      execution_hints: {
        description: 'Execute nodes in topological order',
        decrypt_priority: 'Nodes with decrypt_needed_bitmap bits set should be executed first',
        parallelism: 'Nodes at same depth can be executed in parallel',
      },
      note: 'This is a demo DAG. In production, query actual jobs from batch window.',
    }))
  } catch (e: unknown) {
    log.error('Batch plan error', e)
    return setCors(NextResponse.json({
      message: e instanceof Error ? e.message : 'Internal server error',
      details: e instanceof Error ? e.stack : String(e)
    }, { status: 500 }))
  }
}
