# OpticalBridge

Air-gap file transfer via screen-to-camera optical channel using QR codes.

## How It Works

1. Open `send.html` on the air-gapped computer, select a file
2. Open `receive.html` on a phone or another computer — two modes available:
   - **Camera** — point camera at the sender's screen
   - **Screen Capture** — use a video capture card or `getDisplayMedia` to read the screen directly
3. File transfers optically — no network, no cables, no hardware beyond a display and camera/capture card

## Features

- **Pure offline** — two HTML files, zero build step, vendored JS only
- **Dual receive mode** — camera (phone/laptop) or screen capture (capture card / display sharing)
- **Forward error correction** — Reed-Solomon erasure coding recovers lost frames
- **Interleaved frame order** — Fisher-Yates shuffle per round distributes burst losses across blocks
- **Two-round protocol** — full broadcast then selective retransmission of missing frames
- **Raw binary QR encoding** — frames travel as Latin-1 bytes in QR byte mode, no Base64 overhead
- **SHA-256 verification** — hash displayed on both ends for manual comparison

## Project Structure

```
optical-bridge/
  lib/
    gf256.js           GF(2^8) arithmetic for Reed-Solomon
    frame-protocol.js  Binary frame header packing/unpacking
    reed-solomon.js    Vandermonde-based RS encode/decode
    frame-range.js     Frame range string parser/formatter
    sha256.js          SHA-256 with WebCrypto + pure-JS fallback
    sender.js          Sender engine (file prep, FEC, frame generation)
    receiver.js        Receiver engine (ingest, FEC decode, reassembly)
    qrcode.js          QR code generator (vendored, modified for raw byte mode)
    jsQR.js            QR code decoder (vendored)
  send.html            Sender page
  receive.html         Receiver page
  tests/
    test.html          Unit tests (GF256, FrameProtocol, RS, roundtrip)
    test-qr.html       QR encode/decode self-test
  README.md
```

## Usage

1. Copy the `optical-bridge/` folder to a USB drive
2. **Sender**: open `send.html`, choose mode (Camera/Screen), select a file, click Start
3. **Receiver**: open `receive.html`, select mode, start capture
   - Camera: allow camera access, point at sender's screen
   - Screen Capture: select the sender window/display when prompted
4. Wait for transfer. SHA-256 is shown on both ends — compare to verify integrity
5. If frames are missing after Round 1, copy the missing-frames list from receiver back to sender's "Select frames" mode for retransmission

## Configuration

### Sender settings

| Setting | Camera defaults | Screen defaults | Options |
|---------|----------------|-----------------|---------|
| Frame interval | 150 ms | 50 ms | 33 / 50 / 66 / 80 / 100 / 150 / 200 / 300 / 500 ms |
| QR version | V10 | V20 | V10–V30 |
| FEC (K data + N parity) | K=5, N=1 | K=5, N=1 | K=4,N=1 / K=5,N=1 / K=5,N=2 / K=7,N=3 |
| QR error correction | L (~7%) | L (~7%) | L / M / Q |

### Receiver modes

| Parameter | Camera | Screen Capture |
|-----------|--------|---------------|
| Video source | `getUserMedia` (rear camera) | `getDisplayMedia` |
| Max scan resolution | 640 px | 960 px |
| Scan interval | 150 ms | 50 ms |
| jsQR inversion check | auto | disabled (faster) |
| Canvas hint | `willReadFrequently` | `willReadFrequently` |

## Performance

### Camera mode (V10, 150ms, K=5,N=1)
- Payload per frame: ~251 B
- Raw throughput: ~1.6 KB/s
- Effective (after FEC): **~1.4 KB/s**
- 1 MB file: ~12 minutes

### Screen capture mode (V20, 50ms, K=5,N=1)
- Payload per frame: ~838 B
- Raw throughput: ~16.8 KB/s
- Effective (after FEC): **~14 KB/s**
- 1 MB file: ~70 seconds

Higher QR versions increase payload but reduce clock rate due to encoding/decoding cost. Choose based on the channel quality.

### FEC redundancy

| Scheme | Redundancy | Frames per block | Loss tolerance |
|--------|-----------|-----------------|----------------|
| K=5, N=1 | 20% | 6 | 1 of 6 |
| K=5, N=2 | 40% | 7 | 2 of 7 |
| K=7, N=3 | 43% | 10 | 3 of 10 |

Higher redundancy = more frames to send but higher tolerance to frame loss.

## Limitations

- Camera mode: requires line-of-sight, affected by glare, focus, ambient light
- Screen capture mode: requires a capture card or `getDisplayMedia` (browser permission)
- Performance depends on screen resolution, CPU speed, and browser
- `file://` protocol is required for offline use (disables some browser APIs like Web Crypto)
- Web Workers unavailable under `file://` (jsQR runs synchronously on main thread)

## License

MIT
