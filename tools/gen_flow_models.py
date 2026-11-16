#!/usr/bin/env python3
"""Writes Flow model registry (config/models.json) and ratio/resolution config
(into config/api.json) from values observed live on flow.google.com (2026-11-16).
Image models: Omni 1.2/1.1 Flash. Video: Veo 3.1 Lite/Fast/Quality.
Ratios 16:9, 9:16. Image res 360p/720p. Video durations 4/6/8/10s."""
import json, pathlib
root = pathlib.Path(__file__).resolve().parent.parent

def model(value, name, media, default=False):
    return {"provider": "flow", "value": value, "name": name, "media_type": media,
            "is_default": default, "config": {"dom_value": name, "dom_aliases": [name]}}

models = [
    model("omni-1.2-flash", "Omni 1.2 Flash", "image", True),
    model("omni-1.1-flash", "Omni 1.1 Flash", "image"),
    model("veo-3.1-lite", "Veo 3.1 - Lite", "video", True),
    model("veo-3.1-fast", "Veo 3.1 - Fast", "video"),
    model("veo-3.1-quality", "Veo 3.1 - Quality", "video"),
]
(root / "config/models.json").write_text(json.dumps(models, indent=2, ensure_ascii=False) + "\n")

ratios = {
    "image": [{"value": "16:9", "label": "16:9", "is_default": True}, {"value": "9:16", "label": "9:16"}],
    "video": [{"value": "16:9", "label": "16:9", "is_default": True}, {"value": "9:16", "label": "9:16"}],
}
res = {
    "image": [{"value": "360p", "label": "360p", "menu_label": "360p"},
              {"value": "720p", "label": "720p", "menu_label": "720p", "is_default": True}],
    "video": [{"value": "720p", "label": "720p", "menu_label": "720p", "is_default": True}],
}
durations = [{"value": "4s", "label": "4 giây"}, {"value": "6s", "label": "6 giây"},
             {"value": "8s", "label": "8 giây"}, {"value": "10s", "label": "10 giây", "is_default": True}]

api = json.load(open(root / "config/api.json"))
api.setdefault("flow", {}).setdefault("configs", {})
api["flow"]["configs"].update({
    "flow_v2_driver": {"enabled": True},
    "radix_trigger_button_pattern": "button[id^='radix-'][id$='{suffix}']",
    "ratios": ratios, "download_resolutions": res, "durations": durations,
})
json.dump(api, open(root / "config/api.json", "w"), indent=2, ensure_ascii=False)
print("models:", len(models), "| api.flow.configs keys:", list(api["flow"]["configs"]))
