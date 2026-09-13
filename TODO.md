# Known limitations

- Findings are triaged serially to keep one writer per working tree. A round with many findings can take substantial time.
- A rejected finding can be raised by another reviewer before the settled list is refreshed for the next round. The per-finding exchange limit bounds repeated debate.
- Executable preflight cannot establish provider login or quota health. A reviewer execution failure stops the run after the current round and requires recovery/resume.
- Agent agreement and judge-reported reproduction evidence still require human inspection; they are not proof of correctness.
- Windows and live provider CLI combinations are not fully covered by CI. See the README for supported testing environments.
- Single-PR local-only checkout retention and resume differ from related-PR tasks; review the usage guide before relying on retained fixes.
