# Benchmark harness

Drives `bench.html` in a real Chrome over the DevTools Protocol and prints a
before/after table. No extra dependencies — Node 22's global `WebSocket` speaks
CDP directly.

```bash
npm run build:lib && cp dist/agency-dither-fx.js bench/lib-baseline.js   # A
# ...make changes...
npm run build:lib && cp dist/agency-dither-fx.js bench/lib-optimized.js  # B
node bench/run.mjs --frames=60 --rounds=3
```

Both builds are loaded into one page and run **interleaved**, alternating order
each round, so thermal drift and JIT warmup cannot favour either side. The best
(lowest) round per cell is reported.

## Metrics

| Metric       | Meaning |
| ------------ | ------- |
| `record ms`  | `fx.render()` wall time — main-thread blocking cost only. |
| `flushed ms` | `render()` plus a forced 1×1 readback. Canvas2D **defers rasterisation**, so this is the only honest total; the library's own `drawMs` misses it. |
| `live fps`   | A real `requestAnimationFrame` loop for 2s. |
| phase split  | `sampleMs` / `ditherMs` / `drawMs` straight from `getStats()`. |

`record ms` and `drawMs` badly under-report per-cell drawing, because Chrome only
records display-list ops during `render()` and rasterises them later. Always read
`flushed ms` or `live fps` when judging draw cost.

## Flags

- `--frames=N` measured frames per run (default 90)
- `--rounds=N` interleaved repetitions (default 3)
- `--only=id,id` restrict to named scenarios
- `--headless` run headless (less representative — canvas may fall to software raster)
- `--out=file.json` write raw results
