#!/usr/bin/env python3
"""Writes Flow model registry (config/models.json) and ratio/resolution config
(into config/api.json) from values observed live on flow.google.com (2026-11-16).
Image models: Omni 1.2/1.1 Flash. Video: Veo 3.1 Lite/Fast/Quality.
Ratios 16:9, 9:16. Image res 360p/720p. Video durations 4/6/8/10s."""
import json, pathlib
root = pathlib.Path(__file__).resolve().parent.parent

def model(value, name, media, default=False, **cfg):
    config = {"dom_value": name, "dom_aliases": [name]}
    config.update(cfg)
    return {"provider": "flow", "value": value, "name": name, "media_type": media,
            "is_default": default, "config": config}

# Flow video menu, verified live 2026-11-16 (vi UI). Omni 1.1 Flash, Veo 3.1 Fast and
# Veo 3.1 Quality show "Sẽ ngừng hoạt động vào ngày 5 thg 12" (retiring Dec 5).
#  - Omni 1.2 Flash : resolution 360p/720p, no duration picker
#  - Omni 1.1 Flash : resolution 360p/720p, duration 4/6/8/10s
#  - Veo 3.1 *      : no resolution / duration picker (fixed 8s)
OMNI_RES = {"enabled": True, "default": "720p", "options": [
    {"value": "360p", "label": "360p", "dom_value": "360p"},
    {"value": "720p", "label": "720p", "dom_value": "720p"}]}
models = [
    model("nano-banana-pro", "Nano Banana Pro", "image", True),
    model("nano-banana-2-lite", "Nano Banana 2 Lite", "image"),
    model("nano-banana-2.1", "Nano Banana 2.1", "image"),
    model("omni-1.2-flash", "Omni 1.2 Flash", "video", True, duration_tier="default",
          generation_resolutions=OMNI_RES, supports_ref_video=True, supports_frames=True,
          max_ref_images={"video": 1}),
    model("omni-1.1-flash", "Omni 1.1 Flash", "video", generation_resolutions=OMNI_RES,
          supports_ref_video=True, supports_frames=True, max_ref_images={"video": 1},
          deprecated="2026-12-05"),
    model("veo-3.1-lite", "Veo 3.1 - Lite", "video", duration_tier="default", supports_frames=True),
    model("veo-3.1-fast", "Veo 3.1 - Fast", "video", duration_tier="default", supports_frames=True,
          deprecated="2026-12-05"),
    model("veo-3.1-quality", "Veo 3.1 - Quality", "video", duration_tier="default", supports_frames=True,
          deprecated="2026-12-05"),
]
(root / "config/models.json").write_text(json.dumps(models, indent=2, ensure_ascii=False) + "\n")

ratios = {
    "image": [{"value": v, "label": v, **({"is_default": True} if v == "16:9" else {})}
              for v in ["16:9", "4:3", "1:1", "3:4", "9:16"]],
    "video": [{"value": "16:9", "label": "16:9", "is_default": True}, {"value": "9:16", "label": "9:16"}],
}
res = {
    # NOTE: each item gets "label" below (Motion Studio requires value+label)
    "image": [{"value": "1K", "menu_label": "1K", "route": "native", "is_default": True},
              {"value": "2K", "menu_label": "2K", "route": "native"},
              {"value": "4K", "menu_label": "4K", "route": "native"}],
    "video": [{"value": "720p", "menu_label": "720p", "route": "native", "is_default": True},
              {"value": "1080p", "menu_label": "1080p", "route": "native"}],
    "image_fallback_chain": ["1K", "2K", "4K"],
    "video_fallback_chain": ["720p", "1080p"],
}
for _k in ("image", "video"):
    for _it in res[_k]:
        _it.setdefault("label", _it["menu_label"])
durations = [{"value": "4s", "label": "4 giây"}, {"value": "6s", "label": "6 giây"},
             {"value": "8s", "label": "8 giây"}, {"value": "10s", "label": "10 giây", "is_default": True}]

api = json.load(open(root / "config/api.json"))
api.setdefault("flow", {}).setdefault("configs", {})
api["flow"]["configs"].update({
    "flow_v2_driver": {"enabled": True},
    "radix_trigger_button_pattern": "button[id^='radix-'][id$='{suffix}']",
    "ratios": ratios, "download_resolutions": res, "durations": durations,
    "supports": {"image_mode": True, "video": True, "humanized": False,
                 "ratio": True, "ref_image": True, "max_ref_images": 3},
})
json.dump(api, open(root / "config/api.json", "w"), indent=2, ensure_ascii=False)
print("models:", len(models), "| api.flow.configs keys:", list(api["flow"]["configs"]))
