#!/usr/bin/env python3
"""Writes gemini.selectors into config/dom.json and gemini into config/private.json,
from the live DOM of gemini.google.com (inspected 2026-11-16, account logged in).
Image generation on Gemini: type prompt into rich-textarea, Enter sends, result is a
<single-image><img class="image"> inside <generated-image>/<response-element>."""
import json, pathlib
root = pathlib.Path(__file__).resolve().parent.parent

def s(*sel): return {"selectors": list(sel)}
UNMAPPED = {"selectors": ['[data-566flow-unmapped]']}  # present but never matches

gemini_selectors = {
    "composer": s('rich-textarea .ql-editor[contenteditable="true"]',
                  'rich-textarea [contenteditable="true"]',
                  'div[data-test-id="textarea-wrapper"] [contenteditable="true"]'),
    "response_text": s('message-content .markdown', 'message-content', '.model-response-text'),
    "screen_reader_label": s('.model-response-label-announcer'),
    "image_result": s('single-image img.image', 'generated-image img', 'single-image img'),
    "image_result_container": s('single-image', 'generated-image'),
    "generation_busy_indicator": s('button[aria-label*="Ngừng"]', 'button[aria-label*="Stop"]',
                                   '.model-response-label-announcer[aria-busy="true"]'),
    "stop_button": s('button[aria-label*="Ngừng"]', 'button[aria-label*="Stop"]'),
    "model_switcher_button": s('button[data-test-id="bard-mode-menu-button"]'),
    "model_trigger_label": s('button[data-test-id="bard-mode-menu-button"]'),
    "model_option_button": s('[role="menuitemradio"]', 'button[role="menuitem"]'),
    "model_option_label": s('[role="menuitemradio"] .title', '[role="menuitemradio"]', '[role="menuitem"]'),
    "model_option_selected": s('[role="menuitemradio"][aria-checked="true"]', '[aria-selected="true"]'),
    "upload_in_progress": s('uploader-file-preview mat-progress-spinner',
                            '[data-test-id="uploading-indicator"]'),
    "image_download_button": s('download-generated-image-button button',
                               'single-image button[aria-label*="Tải"]',
                               'single-image button[aria-label*="Download"]'),
    "image_more_menu_button": s('single-image button[aria-label*="Thêm"]',
                                'single-image button[aria-label*="More"]'),
    "image_menu_download_item": s('[role="menuitem"]'),
    # Gemini image mode only — video + motion left unmapped on purpose
    "video_result": UNMAPPED, "video_result_container": UNMAPPED,
    "video_download_button": UNMAPPED, "video_more_menu_button": UNMAPPED,
    "video_menu_download_item": UNMAPPED,
    "motion_audio_user_turn": UNMAPPED, "motion_audio_sent_file": UNMAPPED,
    "delete_confirm_identity": s('[role="dialog"]', 'mat-dialog-container'),
    "delete_confirm_action": s('[role="dialog"] button', 'mat-dialog-container button'),
}

dom = json.load(open(root / "config/dom.json"))
dom.setdefault("gemini", {})["selectors"] = gemini_selectors
json.dump(dom, open(root / "config/dom.json", "w"), indent=2, ensure_ascii=False)

priv = json.load(open(root / "config/private.json"))
priv["gemini"] = {
    "configs": {"ai_agent_prefix": {"en": "Generate an image: ", "vi": "Tạo một hình ảnh: "}},
    # Gemini image composer has no ratio control we can drive yet -> empty (ratio skipped)
    "ratios": {"image": [], "video": []},
}
json.dump(priv["gemini"], open(root / "config/private.json", "w"), indent=2, ensure_ascii=False) if False else None
json.dump(priv, open(root / "config/private.json", "w"), indent=2, ensure_ascii=False)
print("gemini selectors:", len(gemini_selectors), "| private keys:", list(priv["gemini"]))
