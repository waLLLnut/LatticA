#!/usr/bin/env bash
# ==============================================================================
#  Lattica Gatehouse - Real-time Dashboard (ASCII-only, wrap long CIDs)
#  - Emoji-free, ANSI-safe, perfect alignment
#  - Shows full CID handles with robust line-wrapping
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
TERM_WIDTH="${COLUMNS:-88}"
INNER_WIDTH=$(( TERM_WIDTH - 2 ))
(( INNER_WIDTH < 60 )) && INNER_WIDTH=60
(( INNER_WIDTH > 120 )) && INNER_WIDTH=120

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
# Usage: box_wrap "prefix" "text"
# - prefix will be printed at the start of the first line (e.g., "  1. ")
# - follow-up lines are indented with spaces equal to prefix length
box_wrap() {
  local prefix="$1" text="$2"
  local indent="$(printf "%${#prefix}s" "")"
  local space_for_text=$(( INNER_WIDTH - 2 - ${#prefix} ))  # minus side spaces
  (( space_for_text < 10 )) && space_for_text=10

  # We assume text itself has no ANSI codes (CIDs/owners are plain).
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
      # Break on a word boundary if possible
      local chunk="${rest:0:$space_for_text}"
      local cut=$space_for_text
      if [[ "$chunk" =~ ^(.+)[[:space:]/:_-] ]]; then
        # prefer to cut at the last separator/space
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
  box_line "${BOLD}${CYAN}Lattica Gatehouse - Real-time Dashboard${NC}"
  box_line "${DIM}Updated:${NC} $NOW"
  bar_mid

  # Storage
  local STORAGE CONF PEND CAP
  STORAGE="$(printf "%s" "$DATA" | jq '.services.storage')"
  CONF="$(printf "%s" "$STORAGE" | jq -r '.confirmed_cids // 0')"
  PEND="$(printf "%s" "$STORAGE" | jq -r '.pending_cids // 0')"
  CAP="$(printf "%s" "$STORAGE" | jq -r '.capacity // "0/10000"')"

  box_line "${BOLD}${BLUE}Storage Status${NC}"
  kv_line "  ${GREEN}Confirmed${NC}" "$CONF"
  kv_line "  ${YELLOW}Pending${NC}"   "$PEND"
  kv_line "  ${DIM}Capacity${NC}"  "$CAP"
  bar_mid

  # Event Listener
  local L RUN EV ERR SLOT
  L="$(printf "%s" "$DATA" | jq '.services.event_listener')"
  RUN="$(printf "%s" "$L" | jq -r '.is_running // false')"
  EV="$(printf "%s" "$L" | jq -r '.total_events_processed // 0')"
  ERR="$(printf "%s" "$L" | jq -r '.errors_count // 0')"
  SLOT="$(printf "%s" "$L" | jq -r '.last_processed_slot // 0')"

  box_line "${BOLD}${MAGENTA}Event Listener${NC}"
  kv_line "  Status" "$( [ "$RUN" = true ] && echo "${GREEN}Running${NC}" || echo "${RED}Stopped${NC}" )"
  kv_line "  Events processed" "$EV"
  kv_line "  Errors" "$ERR"
  kv_line "  Last slot" "$SLOT"
  bar_mid

  # Job Queue
  local Q QD EX CM FL TJ
  Q="$(printf "%s" "$DATA" | jq '.services.job_queue')"
  QD="$(printf "%s" "$Q" | jq -r '.queued // 0')"
  EX="$(printf "%s" "$Q" | jq -r '.executing // 0')"
  CM="$(printf "%s" "$Q" | jq -r '.completed // 0')"
  FL="$(printf "%s" "$Q" | jq -r '.failed // 0')"
  TJ="$(printf "%s" "$Q" | jq -r '.total_jobs // 0')"

  box_line "${BOLD}${YELLOW}Job Queue${NC}"
  kv_line "  Total" "$TJ"
  box_line "  Queued: $QD   Executing: $EX   Completed: $CM   Failed: $FL"
  bar_mid

  # Recently Confirmed CIDs — FULL handles with wrapping
  if [ "$CONF" -gt 0 ]; then
    box_line "${BOLD}${GREEN}Recently Confirmed CIDs${NC} ${DIM}(latest 5)${NC}"
    local CIDS i=0
    CIDS="$(printf "%s" "$DATA" | jq -r '.services.storage.recent_cids[]? | "\(.cid_pda)|\(.owner)"' | head -5)"
    if [ -n "$CIDS" ]; then
      while IFS='|' read -r cid owner; do
        [ -z "${cid:-}" ] && continue
        i=$((i+1))
        box_wrap "  $i. " "CID PDA: ${cid}"
        box_wrap "     "  "Owner : ${owner}"
      done <<< "$CIDS"
    else
      box_line "  (no CIDs)"
    fi
    box_line "${DIM}Use these CID PDAs for job submission${NC}"
    bar_mid
  fi

  # System Health
  local STATUS MSG
  STATUS="${GREEN}Healthy${NC}"; MSG="All systems operational"
  if [ "$RUN" != "true" ]; then
    STATUS="${RED}Critical${NC}"; MSG="Event Listener stopped"
  elif [ "$ERR" -gt 0 ]; then
    STATUS="${YELLOW}Warning${NC}"; MSG="Errors detected"
  elif [ "$FL" -gt 0 ]; then
    STATUS="${YELLOW}Warning${NC}"; MSG="Some jobs failed"
  fi

  box_line "${BOLD}${CYAN}System Health${NC}"
  kv_line "  Status" "$STATUS"
  box_line "  $MSG"
  bar_bottom

  # Footer
  printf "%sPress %sCtrl+C%s to exit | Refresh %ss | API: %s%s\n" \
    "$DIM" "$BOLD" "$NC" "$INTERVAL" "$API" "$NC"
  printf "%sRegister CID:%s https://www.blinks.xyz/inspector?url=http://localhost:3000/api/actions/job/registerCIDs\n" "$CYAN" "$NC"
  printf "%sSubmit Job:%s   https://www.blinks.xyz/inspector?url=http://localhost:3000/api/actions/job/submit\n" "$CYAN" "$NC"
  printf "%sView DAG:%s     curl http://localhost:3000/api/actions/batch/plan | jq\n" "$CYAN" "$NC"
}

# --------------------------- Main Loop -----------------------------------------
trap 'printf "\n%sDashboard stopped.%s\n" "$CYAN" "$NC"; exit 0' INT
printf "%s%sStarting Lattica Gatehouse Dashboard...%s\n" "$CYAN" "$BOLD" "$NC"
printf "%s(Terminal width: %d cols)%s\n\n" "$DIM" "$INNER_WIDTH" "$NC"

while true; do
  render
  sleep "$INTERVAL"
done
