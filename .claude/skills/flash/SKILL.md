---
name: flash
description: Flash MicroPython firmware or Arduino sketches to embedded hardware. Covers toolchain setup, upload commands, container/bridge/WSL complexities, and structured run log documentation.
type: operational
---

# /flash — Firmware Flash Guide

Flash MicroPython or Arduino firmware to embedded devices from a container, WSL, or over a Windows bridge. After every flash, produce a **Flash Report** in Markdown so the human can verify what actually ran.

---

## Toolchain Quick Reference

### MicroPython (ESP32 / RP2040)

```bash
# Deploy files with mpremote (preferred — handles resets cleanly)
mpremote connect COM13 cp src/main.py :main.py
mpremote connect COM13 ls :/            # verify sizes
mpremote connect COM13 reset

# Run a one-off script and capture output
mpremote connect COM13 run /path/to/script.py

# Erase + reflash full MicroPython firmware (esptool)
esptool.py --chip esp32 --port COM13 erase_flash
esptool.py --chip esp32 --port COM13 write_flash -z 0x1000 firmware.bin
```

### Arduino (arduino-cli)

```bash
arduino-cli board list                          # find port + FQBN
arduino-cli compile --fqbn arduino:avr:uno .   # compile sketch
arduino-cli upload -p COM3 --fqbn arduino:avr:uno .   # upload
```

---

## Container / Bridge / WSL Complexities

Running flash tools from inside a container or WSL adds several friction points:

### 1 — COM ports are Windows-only

USB serial ports (`COM13`, etc.) exist only in the Windows host. From WSL or a Linux container they are invisible. You **must** proxy all serial commands through the Windows bridge:

```bash
curl -s -X POST http://host.docker.internal:8765/exec \
  -H "Content-Type: application/json" \
  -d '{"cmd":"mpremote connect COM13 ls :/"}'
```

### 2 — Paths with spaces break CMD.exe

CMD.exe splits on spaces. `C:\Users\Sup\Ottermatics Dropbox\...` causes:

```
'C:\Users\Sup\Ottermatics' is not recognized as an internal or external command
```

**Fix:** base64-encode a Python helper and pass it via `python.exe -c exec(base64.b64decode(...))`. The helper uses Python's `subprocess` with a proper list argv — no shell splitting:

```python
import subprocess
subprocess.run([mpremote, "connect", "COM13", "cp",
                r"C:\Users\Sup\Ottermatics Dropbox\...\main.py", ":main.py"])
```

### 3 — `python.exe -c "code"` breaks on spaces

CMD splits the `-c` argument on every space, so inline Python with spaces fails. Always use the base64 wrapper:

```bash
B64=$(base64 -w 0 /tmp/helper.py)
curl -X POST http://host.docker.internal:8765/exec \
  -d "{\"cmd\":\"C:\\\\Users\\\\Sup\\\\Anaconda3\\\\envs\\\\fw\\\\python.exe -c exec(__import__('base64').b64decode(b'${B64}'))\"}"
```

### 4 — `mpremote exec` vs `mpremote run`

| Command | Behaviour | Use for |
|---------|-----------|---------|
| `mpremote run file.py` | Soft-reset + run file, streams output | Diagnostics, one-off scripts |
| `mpremote exec "code"` | Inject into live REPL | Avoid — fragile with WDT running |
| `mpremote cp src :dst` | Copy file, no reset | Deploying individual files |
| `mpremote reset` | Hard reset device | After deploying all files |

### 5 — Hardware WDT kills long exec sessions

If the firmware enables `machine.WDT`, the device resets after ~8.3 s of inactivity. Any `mpremote exec` or interactive REPL session that takes longer than the WDT timeout will be killed mid-session. Prefer `run` with pre-written scripts.

### 6 — ESP32 reserved GPIO pins

On standard ESP32 modules, **GPIO 6–11 are connected to internal SPI flash**. Writing to them crashes the device. Never use these as output pins.

---

## Run Log Documentation

> The agent says "it worked" — but you didn't see the output. This section explains how to make every flash operation independently verifiable without watching a terminal.

### Why logs matter

Every `mpremote cp`, `run`, and `reset` call produces stdout/stderr that normally disappears. Capturing it creates an audit trail you can review, diff against previous runs, and attach to issues.

### Log structure

Save flash logs to a persistent location the agent writes to automatically:

```
/workspace/extra/dropbox/Projects/DetoxBox/logs/flash/
  YYYY-MM-DD_HHMM_<operation>.md    ← one file per flash session
  latest.md                          ← symlink or copy of most recent
```

Each log file is a Markdown report (see Flash Report format below).

### Flash Report format

After every flash, the agent **must** produce and save a report:

```markdown
# Flash Report — YYYY-MM-DD HH:MM

## Target
- Device: ESP32 DevKitC / RP2040 Nano Connect / etc.
- Port: COM13
- Firmware: mdns branch @ commit abc1234
- Files deployed: main.py, utils.py, mdns.py

## Commands Run

### 1. mpremote cp main.py :main.py
**Exit code:** 0
**Output:** (none — success)

### 2. mpremote ls :/
**Exit code:** 0
**Output:**
\```
5517 main.py
5532 utils.py
2741 mdns.py
\```

### 3. mpremote reset
**Exit code:** 0

## Post-Flash Verification
- HTTP /ping at 192.168.50.129 → `PONG!` ✓
- mDNS bedtimebox.local → [result]
- Serial boot log excerpt:
\```
PyLang (3, 4, 0) ; micropython
setup...
Connected! IP: 192.168.50.129
mDNS: announced bedtimebox.local -> 192.168.50.129
running server!
\```

## Result
✅ PASS / ❌ FAIL — [one-line summary]
```

### How the agent saves logs

Add this to any flash deploy script:

```python
import datetime, os

log_dir = r"C:\Users\Sup\Ottermatics Dropbox\Projects\DetoxBox\logs\flash"
os.makedirs(log_dir, exist_ok=True)

ts = datetime.datetime.now().strftime("%Y-%m-%d_%H%M")
log_path = os.path.join(log_dir, f"{ts}_deploy.md")

report = f"""# Flash Report — {ts}\n\n## Files\n"""
for fname, result in deploy_results:
    report += f"- {fname}: {result}\n"

with open(log_path, "w") as f:
    f.write(report)

# Update latest.md
with open(os.path.join(log_dir, "latest.md"), "w") as f:
    f.write(report)

print("Log saved to:", log_path)
```

### Verifying a past flash

```bash
# Read the most recent flash report
cat "/workspace/extra/dropbox/Projects/DetoxBox/logs/flash/latest.md"

# List all flash history
ls -lt "/workspace/extra/dropbox/Projects/DetoxBox/logs/flash/"
```

---

## Full Deploy + Report Workflow

When asked to flash firmware:

1. **Identify target** — `arduino-cli board list` or `mpremote connect COM<n> ls :/`
2. **Deploy files** — use `mpremote cp` for each changed file
3. **Verify sizes** — `mpremote ls :/` and compare to local `wc -c`
4. **Reset device** — `mpremote reset`
5. **Boot verification** — wait 8–12s, then HTTP `/ping` or mDNS check
6. **Capture serial output** — `mpremote run <diag_script.py>` to get boot log excerpt
7. **Write and save Flash Report** — Markdown file to `logs/flash/YYYY-MM-DD_HHMM.md` and `latest.md`
8. **Send report to user** — paste the Markdown report in the chat
