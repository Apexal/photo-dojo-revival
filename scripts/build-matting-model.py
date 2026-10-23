"""
Build the background-removal model: ISNet (IS-Net/DIS "general use", Apache-2.0,
as distributed by rembg) with one fix so it runs on ONNX Runtime Web's WebGPU EP.

The fix: every MaxPool has ceil_mode=1, which the WebGPU MaxPool kernel doesn't
implement. The input is a fixed 1024x1024, so every pooled size is a power of
two and ceil_mode changes nothing; we turn it off. The output is checked to be
bit-identical to the original on ONNX Runtime's CPU EP.

It also writes an fp16 copy (weights and arithmetic in half precision; fp32 in
and out) for WebGPU with shader-f16: about half the memory, which iPhones need.
Its output is checked to stay within FP16_TOLERANCE of the fp32 model's.

    uv run --with onnx --with onnxruntime --with numpy python scripts/build-matting-model.py

Writes models/isnet-general-use-webgpu.onnx and models/isnet-general-use-webgpu-fp16.onnx
(served at /models/ by the dev server).
"""

import hashlib
import sys
import urllib.request
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper

SOURCE_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx"
SOURCE_SHA256 = "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a"
OUT = Path(__file__).resolve().parent.parent / "models" / "isnet-general-use-webgpu.onnx"
OUT_FP16 = OUT.with_name("isnet-general-use-webgpu-fp16.onnx")
# Largest allowed difference in the 0..1 mask (measured: ~0.005 on CPU, ~0.02 on Safari's WebGPU).
FP16_TOLERANCE = 0.02


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def to_fp16(model: onnx.ModelProto) -> None:
    """Half precision throughout, fp32 at the edges. ISNet is only Conv/Relu/MaxPool/Resize/Concat/Add/Sigmoid
    (plus shape arithmetic in int64), so converting every float tensor is enough. onnxconverter-common's
    converter mistypes the Resize outputs on this model, hence doing it by hand."""
    graph = model.graph
    F, H = TensorProto.FLOAT, TensorProto.FLOAT16
    half = lambda t: numpy_helper.from_array(numpy_helper.to_array(t).astype(np.float16), t.name)
    for init in graph.initializer:
        if init.data_type == F:
            init.CopyFrom(half(init))
    for node in graph.node:
        for attr in node.attribute:
            if node.op_type == "Cast" and attr.name == "to" and attr.i == F:
                attr.i = H
            if attr.type == onnx.AttributeProto.TENSOR and attr.t.data_type == F:
                attr.t.CopyFrom(half(attr.t))
    del graph.value_info[:]  # fp32 annotations would contradict the new types
    inp = graph.input[0].name
    for node in graph.node:
        node.input[:] = [inp + "_fp16" if x == inp else x for x in node.input]
    graph.node.insert(0, helper.make_node("Cast", [inp], [inp + "_fp16"], to=H))
    for out in graph.output:
        for node in graph.node:
            node.input[:] = [out.name + "_fp16" if x == out.name else x for x in node.input]
            node.output[:] = [out.name + "_fp16" if x == out.name else x for x in node.output]
        graph.node.append(helper.make_node("Cast", [out.name + "_fp16"], [out.name], to=F))
    onnx.checker.check_model(model)


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

    to_fp16(model)
    onnx.save(model, OUT_FP16)
    c = ort.InferenceSession(OUT_FP16).run(["output_image"], {"input_image": x})[0]
    diff = float(np.abs(b - c).max())
    if not diff <= FP16_TOLERANCE:
        print(f"fp16 output too far from fp32 (max diff {diff}); not using it", file=sys.stderr)
        OUT_FP16.unlink()
        return 1
    print(f"fp16 output within {diff:.4f} of fp32\nwrote {OUT_FP16}\nsha256 {sha256(OUT_FP16)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
