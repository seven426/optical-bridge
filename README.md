# OpticalBridge

Air-gap file transfer via screen-to-camera optical channel using QR codes.

## How It Works

1. Open `send.html` on the air-gapped computer, select a file
2. Open `receive.html` on a phone or another computer with a camera
3. Point the camera at the sender's screen
4. File transfers optically — no network, no cables, no hardware

## Features

- **Pure offline** — two HTML files, zero dependencies beyond vendored JS
- **Forward error correction** — Reed-Solomon erasure coding recovers lost frames
- **Two-round protocol** — full broadcast then selective retransmission of missing frames
- **Adaptive QR sizing** — V30/V35/V40 selected by screen height
- **SHA-256 verification** — ensures transferred file integrity

## Project Structure

```
optical-bridge/
  lib/           JavaScript modules and vendored libraries
  send.html      Sender page (open on air-gapped computer)
  receive.html   Receiver page (open on phone / second computer)
  tests/         Browser-based test suite
  README.md
```

## Usage

1. Copy the `optical-bridge/` folder to a USB drive
2. On the air-gapped computer: open `send.html` in a browser, select a file, click Start
3. On the receiving device: open `receive.html`, allow camera access, point at the screen
4. Wait for the file to transfer. Missing frames are shown — communicate them to the sender for a second pass if needed.

## Configuration

Sender settings (expandable panel):
- Frame interval (150–500 ms)
- QR version (auto / V30 / V35 / V40)
- FEC parameters (K data + N parity frames per block)
- QR error correction level

## Performance

With V40 QR @ 200ms/frame, FEC K=5,N=1:
- ~5.5 KB/s effective throughput
- 1 MB file takes ~3 minutes
- Tolerates ~17% frame loss per FEC block

## Limitations

- Requires line-of-sight between screen and camera
- Performance depends on screen brightness, camera quality, ambient light
- Frame rate limited by screen refresh and camera capture speed
- Works best with phone rear camera; laptop webcams may need distance adjustment

## License

MIT
