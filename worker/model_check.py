"""
Qwen-Image-2.1 权重体检（完整版，与 host 侧 model-inspect.ts 口径一致）。

核对每个组件：
- processor / scheduler / vae：配置文件存在且可解析
- text_encoder / transformer：分片齐全 + index 一致 + safetensors 头可读

输出 JSON：{ state, components[], missing[], totalBytes }

用法：
  python worker/model_check.py --model-dir <dir>
  python worker/model_check.py --model-dir <dir> --json
"""

import argparse
import json
import os
import sys


def read_safetensors_header(path: str):
    """解析 safetensors 文件头（前 8 字节 little-endian = JSON header 长度）。"""
    try:
        with open(path, "rb") as f:
            header_len = int.from_bytes(f.read(8), "little")
            if header_len == 0:
                return None
            header_json = f.read(header_len).decode("utf-8")
            return json.loads(header_json)
    except Exception:
        return None


def parse_index(index: dict):
    """从 safetensors index.json 解析张量数与分片数。"""
    if not index:
        return None, None
    weight_map = index.get("weight_map", {})
    shards = set(weight_map.values())
    return len(weight_map), len(shards)


def check_safetensors_dir(dir_path: str, expected_shards: list, index_file: str | None):
    """体检一个 safetensors 目录。"""
    if not os.path.isdir(dir_path):
        return {"state": "missing", "found": 0, "missing": list(expected_shards), "tensorCount": None, "bytes": 0}

    files = os.listdir(dir_path)
    file_set = set(files)
    missing = [s for s in expected_shards if s not in file_set]
    found = len(expected_shards) - len(missing)

    # index 校验
    if index_file and not missing:
        if index_file not in file_set:
            missing.append(index_file)

    # 解析 index
    tensor_count = None
    bytes_total = 0
    if not missing and index_file:
        idx_path = os.path.join(dir_path, index_file)
        idx = read_safetensors_header(idx_path) if idx_path.endswith(".safetensors") else None
        if idx is None:
            try:
                with open(idx_path) as f:
                    idx = json.load(f)
            except Exception:
                idx = None
        if idx:
            tensor_count, _ = parse_index(idx)

    # 字节
    for name in files:
        fp = os.path.join(dir_path, name)
        if os.path.isfile(fp):
            bytes_total += os.path.getsize(fp)

    state = "ok" if not missing else "partial"
    return {"state": state, "found": found, "missing": missing, "tensorCount": tensor_count, "bytes": bytes_total}


def check_config_dir(dir_path: str, expected_files: list):
    """体检一个配置文件目录（processor/scheduler/vae）。"""
    if not os.path.isdir(dir_path):
        return {"state": "missing", "found": 0, "missing": list(expected_files), "bytes": 0}
    files = set(os.listdir(dir_path))
    missing = [f for f in expected_files if f not in files]
    found = len(expected_files) - len(missing)
    bytes_total = sum(os.path.getsize(os.path.join(dir_path, f)) for f in files if os.path.isfile(os.path.join(dir_path, f)))
    return {"state": "ok" if not missing else "partial", "found": found, "missing": missing, "bytes": bytes_total}


def main():
    parser = argparse.ArgumentParser(description="Qwen-Image-2.1 权重体检")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args()

    model_dir = args.model_dir
    if not os.path.isdir(model_dir):
        result = {
            "modelDir": model_dir,
            "exists": False,
            "state": "missing",
            "components": [],
            "missing": [f"目录不存在：{model_dir}"],
        }
    else:
        components = [
            {
                "name": "processor",
                **check_config_dir(os.path.join(model_dir, "processor"), ["preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.json", "merges.txt"]),
            },
            {
                "name": "scheduler",
                **check_config_dir(os.path.join(model_dir, "scheduler"), ["scheduler_config.json"]),
            },
            {
                "name": "text_encoder",
                **check_safetensors_dir(
                    os.path.join(model_dir, "text_encoder"),
                    [
                        "model-00001-of-00004.safetensors",
                        "model-00002-of-00004.safetensors",
                        "model-00003-of-00004.safetensors",
                        "model-00004-of-00004.safetensors",
                    ],
                    "model.safetensors.index.json",
                ),
            },
            {
                "name": "transformer",
                **check_safetensors_dir(
                    os.path.join(model_dir, "transformer"),
                    [
                        "diffusion_pytorch_model-00001-of-00002.safetensors",
                        "diffusion_pytorch_model-00002-of-00002.safetensors",
                    ],
                    "diffusion_pytorch_model.index.json",
                ),
            },
            {
                "name": "vae",
                **check_config_dir(os.path.join(model_dir, "vae"), ["config.json", "diffusion_pytorch_model.safetensors"]),
            },
        ]

        missing = []
        state = "ok"
        for comp in components:
            if comp["state"] == "missing":
                state = "missing"
            elif comp["state"] == "partial" and state != "missing":
                state = "partial"
            missing.extend(comp["missing"])

        total_bytes = sum(c.get("bytes", 0) for c in components)

        result = {
            "modelDir": model_dir,
            "exists": True,
            "state": state,
            "components": components,
            "missing": missing,
            "totalBytes": total_bytes,
        }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
