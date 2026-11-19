"""Static TFLite inspection; URLs are read into memory, never saved.

Requires tflite==2.18.0 and flatbuffers==25.2.10 (no TensorFlow runtime).
This does not execute a model or establish a licence or arena requirement.
"""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import urllib.request

import tflite


def enum_names(enum):
    return {value: name for name, value in vars(enum).items() if isinstance(value, int)}


def vector(obj, field):
    return [getattr(obj, field)(i) for i in range(getattr(obj, field + "Length")())]


def decode(value):
    return value.decode("utf-8", errors="replace") if value else ""


def tensor_summary(tensor):
    quant = tensor.Quantization()
    return {
        "name": decode(tensor.Name()),
        "shape": vector(tensor, "Shape"),
        "dtype": enum_names(tflite.TensorType)[tensor.Type()],
        "variable": tensor.IsVariable(),
        "quantization": {
            "scales": vector(quant, "Scale"),
            "zero_points": vector(quant, "ZeroPoint"),
            "dimension": quant.QuantizedDimension(),
        } if quant else None,
    }


def options(operator, cls):
    table = operator.BuiltinOptions()
    result = cls()
    result.Init(table.Bytes, table.Pos)
    return result


def inspect(source):
    if source.startswith("https://"):
        with urllib.request.urlopen(source, timeout=30) as response:
            data = response.read(16 * 1024 * 1024 + 1)
    else:
        data = Path(source).read_bytes()
    if len(data) > 16 * 1024 * 1024 or data[4:8] != b"TFL3":
        raise ValueError("Expected a TFL3 flatbuffer no larger than 16 MiB")
    model = tflite.Model.GetRootAsModel(data, 0)
    builtin_names = enum_names(tflite.BuiltinOperator)
    codes = []
    for index in range(model.OperatorCodesLength()):
        code = model.OperatorCodes(index)
        codes.append({"name": builtin_names[code.BuiltinCode()],
                      "version": code.Version(), "custom": decode(code.CustomCode())})
    graphs = []
    for index in range(model.SubgraphsLength()):
        graph = model.Subgraphs(index)
        operators = []
        for position in range(graph.OperatorsLength()):
            operator = graph.Operators(position)
            code = codes[operator.OpcodeIndex()]
            entry = {"position": position, **code,
                     "inputs": vector(operator, "Inputs"),
                     "outputs": vector(operator, "Outputs")}
            if code["name"] == "CALL_ONCE":
                entry["init_subgraph"] = options(operator, tflite.CallOnceOptions).InitSubgraphIndex()
            if code["name"] == "VAR_HANDLE":
                handle = options(operator, tflite.VarHandleOptions)
                entry["container"] = decode(handle.Container())
                entry["shared_name"] = decode(handle.SharedName())
            operators.append(entry)
        graphs.append({
            "index": index, "name": decode(graph.Name()),
            "inputs": vector(graph, "Inputs"), "outputs": vector(graph, "Outputs"),
            "operator_counts": dict(Counter(op["name"] for op in operators)),
            "tensors": [tensor_summary(graph.Tensors(i)) for i in range(graph.TensorsLength())],
            "operators": operators,
        })
    return {"source": source, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "schema_version": model.Version(), "operator_codes": codes, "subgraphs": graphs}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", nargs="+", help="Existing .tflite paths or explicit HTTPS URLs")
    args = parser.parse_args()
    print(json.dumps([inspect(source) for source in args.sources], indent=2))


if __name__ == "__main__":
    main()
