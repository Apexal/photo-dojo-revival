"""
Build the background-removal model: ISNet (IS-Net/DIS "general use", Apache-2.0,
as distributed by rembg) with one fix so it runs on ONNX Runtime Web's WebGPU EP.

The fix: every MaxPool has ceil_mode=1, which the WebGPU MaxPool kernel doesn't
implement. The input is a fixed 1024x1024, so every pooled size is a power of
two and ceil_mode changes nothing; we turn it off. The output is checked to be
bit-identical to the original on ONNX Runtime's CPU EP.

    uv run --with onnx --with onnxruntime --with numpy python scripts/build-matting-model.py

Writes models/isnet-general-use-webgpu.onnx (served at /models/ by the dev server).
"""

import hashlib
import sys
import urllib.request
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort

SOURCE_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx"
SOURCE_SHA256 = "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a"
OUT = Path(__file__).resolve().parent.parent / "models" / "isnet-general-use-webgpu.onnx"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    OUT.parent.mkdir(exist_ok=True)
    src = OUT.parent / "isnet-general-use.onnx"
    if not src.exists():
        print(f"downloading {SOURCE_URL}")
        urllib.request.urlretrieve(SOURCE_URL, src)
    if sha256(src) != SOURCE_SHA256:
        print(f"{src} doesn't match the expected SHA-256; delete it and re-run", file=sys.stderr)
        return 1

    model = onnx.load(src)
    patched = 0
    for node in model.graph.node:
        if node.op_type == "MaxPool":
            for attr in node.attribute:
                if attr.name == "ceil_mode" and attr.i == 1:
                    attr.i = 0
                    patched += 1
    onnx.save(model, OUT)
    print(f"MaxPool ceil_mode turned off on {patched} nodes")

    x = np.random.default_rng(0).standard_normal((1, 3, 1024, 1024)).astype(np.float32)
    a = ort.InferenceSession(src).run(["output_image"], {"input_image": x})[0]
    b = ort.InferenceSession(OUT).run(["output_image"], {"input_image": x})[0]
    diff = float(np.abs(a - b).max())
    if diff != 0:
        print(f"output changed (max diff {diff}); not using this model", file=sys.stderr)
        OUT.unlink()
        return 1
    print(f"output bit-identical to the original\nwrote {OUT}\nsha256 {sha256(OUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
