#!/usr/bin/env bash
# ==============================================================================
#  Lattica Gatehouse - Enhanced Real-time Dashboard
#  - Detailed Job Queue View for FHE Executor Interface
#  - Recent Events Feed
#  Usage: ./dashboard.sh [interval_seconds]
# ==============================================================================

set -u

# --------------------------- Colors --------------------------------------------
if command -v tput >/dev/null 2>&1 && [ -t 1 ]; then
  BOLD="$(tput bold)"; DIM="$(tput dim 2>/dev/null || printf '')"
  RED="$(tput setaf 1)"; GREEN="$(tput setaf 2)"; YELLOW="$(tput setaf 3)"
  BLUE="$(tput setaf 4)"; MAGENTA="$(tput setaf 5)"; CYAN="$(tput setaf 6)"
  NC="$(tput sgr0)"
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; MAGENTA=""; CYAN=""; NC=""
fi
[ "${NO_COLOR:-}" != "" ] && { BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; MAGENTA=""; CYAN=""; NC=""; }

# --------------------------- Config --------------------------------------------
INTERVAL="${1:-2}"
API="http://localhost:3000/api/init"

# Terminal width → inner content width (between side borders)
TERM_WIDTH="${COLUMNS:-100}"
INNER_WIDTH=$(( TERM_WIDTH - 2 ))
(( INNER_WIDTH < 80 )) && INNER_WIDTH=80
(( INNER_WIDTH > 140 )) && INNER_WIDTH=140

# --------------------------- Box helpers ---------------------------------------
repeat_char() { local c="$1" n="$2"; printf "%0.s${c}" $(seq 1 "$n"); }
bar_top()    { printf "+%s+\n" "$(repeat_char '-' "$INNER_WIDTH")"; }
bar_mid()    { printf "+%s+\n" "$(repeat_char '-' "$INNER_WIDTH")"; }
bar_bottom() { printf "+%s+\n" "$(repeat_char '-' "$INNER_WIDTH")"; }

# Strip ANSI codes for visible-length calculation
strip_ansi() { sed -E 's/\x1B\[[0-9;]*[A-Za-z]//g'; }

# Print one padded line
box_line() {
  local text="$1"
  local visible; visible="$(printf "%s" "$text" | strip_ansi)"
  local len=${#visible}
  local pad=$(( INNER_WIDTH - len - 2 ))
  (( pad < 0 )) && pad=0
  printf "| %s%*s |\n" "$text" "$pad" ""
}

# Key:Value aligned single line
kv_line() {
  local label="$1" value="$2"
  local pl pv total pad
  pl="$(printf "%s" "$label" | strip_ansi)"
  pv="$(printf "%s" "$value" | strip_ansi)"
  total=$(( ${#pl} + ${#pv} + 3 ))   # "label : value"
  pad=$(( INNER_WIDTH - total - 2 ))
  (( pad < 0 )) && pad=0
  printf "| %s : %s%*s |\n" "$label" "$value" "$pad" ""
}

# Soft-wrap long text into multiple box lines (ANSI-safe).
box_wrap() {
  local prefix="$1" text="$2"
  local indent="$(printf "%${#prefix}s" "")"
  local space_for_text=$(( INNER_WIDTH - 2 - ${#prefix} ))
  (( space_for_text < 10 )) && space_for_text=10

  local rest="$text"
  local first=1
  while [ -n "$rest" ]; do
    if [ ${#rest} -le $space_for_text ]; then
      if [ $first -eq 1 ]; then
        box_line "${prefix}${rest}"
      else
        box_line "${indent}${rest}"
      fi
      break
    else
      local chunk="${rest:0:$space_for_text}"
      local cut=$space_for_text
      if [[ "$chunk" =~ ^(.+)[[:space:]/:_-] ]]; then
        cut="${#BASH_REMATCH[1]}+1"
        cut=$((cut))
        if [ $cut -lt 10 ]; then cut=$space_for_text; fi
      fi
      if [ $first -eq 1 ]; then
        box_line "${prefix}${rest:0:$cut}"
        first=0
      else
        box_line "${indent}${rest:0:$cut}"
      fi
      rest="${rest:$cut}"
    fi
  done
}

# Format timestamp
format_time() {
  local ts="$1"
  if [ "$ts" = "null" ] || [ -z "$ts" ] || [ "$ts" = "0" ]; then
    echo "-"
  else
    date -r "$ts" '+%H:%M:%S' 2>/dev/null || echo "$ts"
  fi
}

# Truncate string with ellipsis
truncate_str() {
  local str="$1" maxlen="${2:-16}"
  if [ ${#str} -le $maxlen ]; then
    echo "$str"
  else
    echo "${str:0:$((maxlen-3))}..."
  fi
}

# --------------------------- Render --------------------------------------------
render() {
  clear

  if ! curl -s --max-time 2 "$API" >/dev/null 2>&1; then
    echo "${RED}${BOLD}Server not reachable${NC}"
    echo "${DIM}Start the server with:${NC} npm run dev"
    return
  fi

  local DATA NOW
  DATA="$(curl -s "$API")"
  NOW="$(date '+%Y-%m-%d %H:%M:%S')"

  # Header
  bar_top
  box_line "${BOLD}${CYAN}Lattica Gatehouse - FHE Executor Dashboard${NC}"
  box_line "${DIM}Updated:${NC} $NOW"
  bar_mid

  # System Overview (compact)
  local STORAGE CONF PEND L RUN EV ERR SLOT
  STORAGE="$(printf "%s" "$DATA" | jq '.services.storage')"
  CONF="$(printf "%s" "$STORAGE" | jq -r '.confirmed_cids // 0')"
  PEND="$(printf "%s" "$STORAGE" | jq -r '.pending_cids // 0')"

  L="$(printf "%s" "$DATA" | jq '.services.event_listener')"
  RUN="$(printf "%s" "$L" | jq -r '.is_running // false')"
  EV="$(printf "%s" "$L" | jq -r '.total_events_processed // 0')"
  ERR="$(printf "%s" "$L" | jq -r '.errors_count // 0')"
  SLOT="$(printf "%s" "$L" | jq -r '.last_processed_slot // 0')"

  box_line "${BOLD}${BLUE}System Status${NC}"
  box_line "  CIDs: ${GREEN}$CONF confirmed${NC}, ${YELLOW}$PEND pending${NC}  |  Listener: $( [ "$RUN" = true ] && echo "${GREEN}Running${NC}" || echo "${RED}Stopped${NC}" ) ($EV events, $ERR errors)"
  bar_mid

  # Job Queue Details
  local Q QD EX CM FL TJ JOBS
  Q="$(printf "%s" "$DATA" | jq '.services.job_queue')"
  QD="$(printf "%s" "$Q" | jq -r '.queued // 0')"
  EX="$(printf "%s" "$Q" | jq -r '.executing // 0')"
  CM="$(printf "%s" "$Q" | jq -r '.completed // 0')"
  FL="$(printf "%s" "$Q" | jq -r '.failed // 0')"
  TJ="$(printf "%s" "$Q" | jq -r '.total_jobs // 0')"

  box_line "${BOLD}${YELLOW}Job Queue${NC} ${DIM}(FHE Executor Interface)${NC}"
  box_line "  Total: $TJ  |  ${YELLOW}Queued: $QD${NC}  |  ${CYAN}Executing: $EX${NC}  |  ${GREEN}Completed: $CM${NC}  |  ${RED}Failed: $FL${NC}"

  # Detailed Job List - ALL jobs (queued, executing, completed, failed)
  JOBS="$(printf "%s" "$Q" | jq -r '.jobs[]? | "\(.job_pda)|\(.status)|\(.cid_count)|\(.ir_digest)|\(.operation)|\(.operation_desc)|\(.queued_at)|\(.slot)|\(.executor // "none")|\(.execution_started_at // 0)|\(.execution_completed_at // 0)"')"

  if [ -n "$JOBS" ] && [ "$JOBS" != "null" ]; then
    bar_mid
    box_line "${BOLD}${CYAN}All Jobs (Recent Activity)${NC}"

    local i=0
    while IFS='|' read -r job_pda status cid_count ir_digest operation operation_desc queued_at slot executor exec_start exec_end; do
      [ -z "${job_pda:-}" ] || [ "$job_pda" = "null" ] && continue
      i=$((i+1))

      # Status color & uppercase (POSIX-compatible)
      local status_color="$YELLOW"
      local status_upper
      status_upper="$(echo "$status" | tr '[:lower:]' '[:upper:]')"

      case "$status" in
        queued) status_color="$YELLOW" ;;
        assigned) status_color="$BLUE" ;;
        executing) status_color="$CYAN" ;;
        completed) status_color="$GREEN" ;;
        failed) status_color="$RED" ;;
      esac

      # Operation type display with color coding (capitalize first letter)
      local operation_display="" operation_desc_display=""
      local operation_capitalized
      operation_capitalized="$(echo "$operation" | awk '{print toupper(substr($0,1,1)) tolower(substr($0,2))}')"

      case "$operation" in
        deposit)
          operation_display="${GREEN}${operation_capitalized}${NC}"
          ;;
        withdraw)
          operation_display="${YELLOW}${operation_capitalized}${NC}"
          ;;
        borrow)
          operation_display="${CYAN}${operation_capitalized}${NC}"
          ;;
        liquidation)
          operation_display="${RED}${operation_capitalized}${NC}"
          ;;
        *)
          operation_display="${MAGENTA}${operation_capitalized}${NC}"
          ;;
      esac

      operation_desc_display="${DIM}FHE: ${operation_desc}${NC}"

      # Timeline
      local timeline=""
      if [ "$status" = "completed" ] || [ "$status" = "failed" ]; then
        timeline="Queued→Exec→Done: $(format_time "$queued_at") → $(format_time "$exec_start") → $(format_time "$exec_end")"
      elif [ "$status" = "executing" ] || [ "$status" = "assigned" ]; then
        timeline="Queued→Exec: $(format_time "$queued_at") → $(format_time "$exec_start")"
      else
        timeline="Queued: $(format_time "$queued_at")"
      fi

      box_line ""
      box_line "  ${BOLD}Job #$i${NC}  [${status_color}${status_upper}${NC}]  Operation: ${operation_display}"
      box_wrap "    " "PDA: $(truncate_str "$job_pda" 60)"
      box_line "    CIDs: $cid_count  |  IR Digest: $(truncate_str "$ir_digest" 24)"
      box_line "    ${operation_desc_display}"
      box_line "    Executor: $(truncate_str "$executor" 30)"
      box_line "    Timeline: ${DIM}${timeline}${NC}"
    done <<< "$JOBS"

    if [ $i -eq 0 ]; then
      box_line "  ${DIM}No jobs yet${NC}"
    fi
  else
    box_line "  ${DIM}No jobs in queue${NC}"
  fi

  bar_mid

  # Recent Events (last 3)
  box_line "${BOLD}${MAGENTA}Recent On-Chain Events${NC}"
  box_line "  ${DIM}Last slot processed:${NC} $SLOT"
  box_line "  ${DIM}Total events:${NC} $EV  ${DIM}|${NC}  ${RED}Errors:${NC} $ERR"

  # Show recent CIDs as proxy for events
  if [ "$CONF" -gt 0 ]; then
    box_line ""
    box_line "  ${DIM}Latest CID Registrations:${NC}"
    local CIDS i=0
    CIDS="$(printf "%s" "$DATA" | jq -r '.services.storage.recent_cids[]? | "\(.cid_pda)|\(.created_at)"' | head -3)"
    if [ -n "$CIDS" ]; then
      while IFS='|' read -r cid created_at; do
        [ -z "${cid:-}" ] && continue
        i=$((i+1))
        box_line "    $i. $(truncate_str "$cid" 48)  ${DIM}$(format_time "$created_at")${NC}"
      done <<< "$CIDS"
    fi
  fi

  bar_bottom

  # Footer - FHE Executor Instructions
  printf "%s${BOLD}FHE Executor Interface:${NC}\n" "$CYAN"
  printf "%s  1. Monitor 'Active Jobs' section above for queued jobs\n" "$DIM"
  printf "  2. Fetch job details: GET /api/init (see job_pda, ir_digest, cid_handles)\n"
  printf "  3. Execute FHE computation on CID data\n"
  printf "  4. Submit result back via API (TODO: implement result submission endpoint)%s\n\n" "$NC"

  printf "%sPress %sCtrl+C%s to exit | Refresh %ss%s\n" "$DIM" "$BOLD" "$NC" "$INTERVAL" "$NC"
  printf "%sRegister CID:%s https://www.blinks.xyz/inspector?url=http://localhost:3000/api/actions/job/registerCIDs\n" "$CYAN" "$NC"
  printf "%sSubmit Job:%s   https://www.blinks.xyz/inspector?url=http://localhost:3000/api/actions/job/submit\n" "$CYAN" "$NC"
}

# --------------------------- Main Loop -----------------------------------------
trap 'printf "\n%sDashboard stopped.%s\n" "$CYAN" "$NC"; exit 0' INT
printf "%s%sStarting Lattica Gatehouse FHE Executor Dashboard...%s\n" "$CYAN" "$BOLD" "$NC"
printf "%s(Terminal width: %d cols)%s\n\n" "$DIM" "$INNER_WIDTH" "$NC"

while true; do
  render
  sleep "$INTERVAL"
done
