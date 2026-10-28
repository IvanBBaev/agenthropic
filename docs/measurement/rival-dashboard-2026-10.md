# Rival dashboard — the five daily questions against one free alternative

> ## ⚠ EMPTY — no rival installed or tried yet
>
> This is the recording artifact for the Step-0 row "Install ≥1 free rival dashboard" in
> [`TODO.md`](https://github.com/IvanBBaev/agenthropic/blob/main/TODO.md) (lane L2 of
> [`branch-lanes-2026-10-28.md`](../analysis/branch-lanes-2026-10-28.md)). Only Ivan records
> answers: whether a rival answers a question is a judgement made at the screen, not by an
> agent reading the rival's README.

## 1. The rival

Best-path action 2 names `claude-code-templates --analytics` (free, reads the same
`~/.claude/projects` corpus). Any other free dashboard is fine; record which one.

| Field | Value |
|---|---|
| Name and version | |
| Install command | |
| Date tried | |
| Corpus it read | `~/.claude/projects` (read-only) |

Install and run it outside this repository; nothing it creates belongs in the tree. If it
asks for a network bind other than loopback, or to spawn `claude`, note that below — it is
exactly the difference agenthropic is built on.

## 2. The five daily questions

The questions are decision D3, verbatim as in
[`time-to-understand-protocol.md`](time-to-understand-protocol.md). For each: **yes** (answered
directly), **partly** (answered with effort or a missing piece), **no**; the time to the
answer; one line on how.

| # | Question | Rival: yes / partly / no | Time | How / what was missing |
|---|---|---|---|---|
| Q1 | What is the subagent tree of this session, and which branch is still running? | | | |
| Q2 | Which agent/subagent burned the most tokens (and roughly what did it cost)? | | | |
| Q3 | Did any session get stuck / error without me noticing? | | | |
| Q4 | What did today/this week cost, and how much did Haiku/Sonnet routing save? | | | |
| Q5 | Show me last night's sessions — persisted, after a restart. | | | |

## 3. Verdict

_Filled by Ivan:_ which questions only agenthropic answers, which the rival answers as well
or better, and whether that changes what v1.0 should claim.
