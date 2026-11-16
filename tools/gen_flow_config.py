#!/usr/bin/env python3
"""Generates config/dom.json + config/api.json (flow) and tools/flow-selector-check.js.

!! The Flow selectors below are BEST-EFFORT GUESSES written without access to the live
!! page. Run tools/flow-selector-check.js in the DevTools console on flow.google.com,
!! then correct the keys that report 0 matches.
"""
import json, pathlib
root = pathlib.Path(__file__).resolve().parent.parent

def s(*selectors, **extra):
    d = {"selectors": list(selectors)}
    d.update(extra)
    return d

flow_selectors = {
  # Verified on flow.google.com (2026-11-16): Angular custom elements, locale-independent.
  "slate_editor": s('flow-rich-text-editor [contenteditable="true"]',
                    'flow-base-prompt-box [contenteditable="true"]'),
  "submit_button": s('flow-generate-icon-button button', 'flow-base-prompt-box button[type="submit"]',
                     icon_text="arrow_forward"),
  "settings_button": s('flow-base-prompt-box button[class*="settings-"]'),
  "flow_agent_toggle_button": s('flow-agent-mode-toggle-chip button', 'button.agent-mode-chip',
                                aria_pressed_on="true"),
  "agent_mode_active": s('button.agent-mode-chip[aria-pressed="true"]'),
  "add_component_root": s('flow-add-menu'),
  # the tile element has no id of its own; the id is <img data-media-id> inside it.
  # Without `attribute` the tile selector resolved to null -> no tile was ever seen
  # -> every Task waited for the full timeout ("No new results after submit").
  "tile_container": s('flow-grid-tile-container', attribute="data-media-id",
                      persistent_id_attribute="data-media-id",
                      # tile aria-label = file/display name (used to find our own upload)
                      display_name_attribute="aria-label"),
  "tile_image": s('flow-image-tile img[data-media-id]', 'flow-image-tile img.image',
                  attribute="data-media-id", persistent_id_attribute="data-media-id"),
  "tile_video": s('flow-video-tile video'),
  "tile_video_poster": s('flow-video-tile img.thumbnail'),
  "tile_video_owner": s('flow-video-tile'),
  # verified live 2026-11-16: uploads and generations show <flow-pending-tile> (x%) until done
  "tile_pending": s('flow-pending-tile', 'flow-grid-tile-container [role="progressbar"]'),
  "flow_scroll_container": s('cdk-virtual-scroll-viewport'),
  "context_menu": s('.mat-mdc-menu-panel', '[role="menu"]'),
  "menu_item": s('.mat-mdc-menu-item', '[role="menuitem"]'),
  "download_menu_trigger": s('.mat-mdc-menu-item', '[role="menuitem"]', icon_text="download"),
  "download_submenu": s('.mat-mdc-menu-panel', '[role="menu"]'),
  "download_submenu_item": s('.mat-mdc-menu-item', '[role="menuitem"]',
                             disabled_attributes=["disabled", "aria-disabled"]),
  # model picker (verified live 2026-11-16): trigger lives in the composer settings
  # popover; items carry the name in .label and a retirement note in .caption, so
  # matching must read .label only (exact-label match otherwise fails).
  "model_picker_button": s('button.mat-mdc-menu-trigger:has(.model-select-trigger-content)',
                           '.settings-content button.mat-mdc-menu-trigger'),
  "model_picker_panel": s('.flow-model-picker-panel', '.mat-mdc-menu-panel'),
  "model_picker_item": s('flow-menu-item.model-select-option button', '.flow-model-picker-panel .mat-mdc-menu-item',
                         label_selector='.item-text .label', ignored_text_selectors=['.caption'],
                         selected_owner='flow-menu-item', class_selected='selected'),
  "icon_element": s('mat-icon'),
  "ingredient_bar": s('flow-add-menu', 'flow-base-prompt-box [class*="ingredient"]'),
  "ingredient_remove_button": s('button[aria-label*="emove"]', 'button[aria-label*="X\u00f3a"]',
                                'flow-add-menu button[aria-label*="close"]', icon_text="close"),
  "ingredient_image_chip": s('flow-add-menu [class*="image"]', '[data-ingredient-kind="image"]'),
  "ingredient_video_chip": s('flow-add-menu [class*="video"]', '[data-ingredient-kind="video"]'),
  "ingredient_chip_thumbnail": s('flow-add-menu img'),
  # add-component menu / reference-image upload (verified live 2026-11-16)
  "add_component_root": s('flow-add-menu', '.cdk-overlay-pane'),
  "add_menu_upload_media_button": s('.cdk-overlay-pane button[mat-button]', 'flow-add-menu button',
                                    icon_text="upload"),
  "add_menu_upload_tab": s('.cdk-overlay-pane [role="tab"]', '.cdk-overlay-pane button'),
  "add_component_apply_button": s('.cdk-overlay-pane button[mat-button]', icon_text=""),
  "add_component_listbox": s('.cdk-overlay-pane [role="listbox"]', '.cdk-overlay-pane mat-list'),
  "add_component_option": s('.cdk-overlay-pane [role="option"]', '.cdk-overlay-pane [mat-list-item]'),
  "reference_picker_search": s('.cdk-overlay-pane input[type="text"]', '.cdk-overlay-pane input'),
  # settings panel + its radio controls (verified live 2026-11-16)
  "settings_panel_candidates": s('.cdk-overlay-pane'),
  "settings_panel_marker": s('mat-button-toggle'),
  "settings_panel_root": s('.cdk-overlay-pane'),
  "mode_tab_image": s('mat-button-toggle button[role="radio"]', icon_text="image"),
  "mode_tab_video": s('mat-button-toggle button[role="radio"]', icon_text="videocam"),
  "video_mode_frames": s('mat-button-toggle button[role="radio"]', icon_text="crop_free"),
  "video_mode_ingredients": s('mat-button-toggle button[role="radio"]', icon_text="chrome_extension"),
  "ratio_button": s('mat-button-toggle button[role="radio"]',
                    ratio_icons={"16:9": "crop_16_9", "4:3": "crop_landscape", "1:1": "crop_square", "3:4": "crop_portrait", "9:16": "crop_9_16"}),
  "quantity_button": s('mat-button-toggle button[role="radio"]', text_format="x{value}"),
  "tab_button_generic": s('mat-button-toggle button[role="radio"]'),
  # video resolution (Omni: 360p/720p) and duration (Omni 1.1: 4/6/8/10 giây) radios.
  # 360p carries an "info" icon, so read only .toggle-text.
  "video_resolution_tab": s('mat-button-toggle button[role="radio"]', label_selector='.toggle-text'),
  "video_duration_tab": s('mat-button-toggle button[role="radio"]', label_selector='.toggle-text'),
  # page state
  "signed_out_indicator": s('a[href*="accounts.google.com/ServiceLogin"]', 'a[href*="accounts.google.com/signin"]'),
  "project_card": s('a[href*="/project/"]'),
  "project_link": s('a[href*="/project/"]'),
  "projects_page": s('main'),
  "project_title": s('flow-editable-text'),
  # --- verified live 2026-11-16 (second pass) ---------------------------------
  # homepage "+ Dự án mới" FAB
  "new_project_button": s('button.mat-mdc-fab', 'button.mdc-fab',
                          icon_text=["add"], text_match=["Dự án mới", "New project"]),
  # composer "+" that opens the add-component popover
  "composer_advanced_menu_button": s('flow-base-prompt-box button', icon_text="add"),
  "add_component_root": s('flow-add-menu-popover-content', 'flow-add-menu'),
  "add_component_image_tab": s('flow-add-menu-side-nav [role="tab"]', icon_text="image",
                               attribute_selected="aria-selected"),
  "add_component_video_tab": s('flow-add-menu-side-nav [role="tab"]', icon_text="videocam",
                               attribute_selected="aria-selected"),
  "add_component_voice_tab": s('flow-add-menu-side-nav [role="tab"]', icon_text="voice_selection",
                               attribute_selected="aria-selected"),
  "add_component_character_tab": s('flow-add-menu-side-nav [role="tab"]', icon_text="accessibility_new",
                                   attribute_selected="aria-selected"),
  "add_component_listbox": s('flow-add-menu-asset-list cdk-virtual-scroll-viewport',
                             'flow-add-menu-asset-list'),
  "add_component_option": s('button.asset-item[role="option"]', 'flow-add-menu-asset-list [role="option"]'),
  "reference_picker_search": s('input.search-input', 'flow-add-menu-popover-content input'),
  "reference_picker_thumbnail": s('img.asset-thumbnail-image'),
  "reference_picker_project": s('.sidebar-project-selector .mat-mdc-select-value-text'),
  # desktop layout only: a selector that never matches the desktop popover
  "reference_picker_mobile_root": s('flow-add-menu-popover-content.mobile-layout'),
  # reference chips shown above the prompt after attaching
  "ingredient_bar": s('flow-ingredient-bar'),
  "ingredient_image_chip": s('flow-image-ingredient-chip'),
  "ingredient_video_chip": s('flow-video-ingredient-chip'),
  "ingredient_chip_thumbnail": s('img.chip-image'),
  "ingredient_remove_button": s('.hover-icon-overlay', 'button.chip-container', icon_text="cancel"),
  "prompt_clear_button": s('button[aria-label="Xoá câu lệnh"]', 'button[aria-label="Xóa câu lệnh"]',
                           'button[aria-label="Clear prompt"]', icon_text="close"),
  # project page "Cài đặt" (settings_2) menu: view mode / grid size / tile details
  "page_settings_trigger": s('button.mat-mdc-icon-button', icon_text="settings_2"),
  "page_settings_root": s('flow-tile-view-settings'),
  "page_settings_grid_view": s('mat-button-toggle button[role="radio"]', icon_text="dashboard",
                               attribute_selected="aria-checked"),
  "page_settings_grid_size": s('mat-button-toggle button[role="radio"]', attribute_selected="aria-checked",
                               values={"small": ["N", "S", "Nhỏ", "Small"],
                                       "medium": ["TB", "M", "Medium"], "large": ["L", "Lớn", "Large"]},
                               first_item_fallback={"enabled": True, "value": "small",
                                                    "group_selectors": ['flow-toggles[aria-label*="kích thước"]',
                                                                        'flow-toggles[aria-label*="size" i]']}),
  # --- third pass (2026-11-16): upload/ref/error flow, from live DOM + Flow bundle ---
  "tile_display_name": s('span.footer-title', '.footer-title'),
  "tile_error_owner": s('flow-error-tile'),
  "tile_error_message": s('.error-message-text', '.error-message'),
  "tile_retry_button": s('flow-error-tile button', icon_text="refresh"),
  "warning_icon": s('mat-icon', text_match=["warning"]),
  # video upload shows "Quyền sử dụng video này" -> [Huỷ] [Tôi đồng ý, không hiện lại] [Tôi đồng ý];
  # click the plain "Tôi đồng ý" (last button), never the "don't show again" one.
  "video_upload_confirm": s('mat-dialog-container .agree-actions-group button:last-child',
                            text_match=["Tôi đồng ý", "I agree"]),
  "upload_consent_confirm": s('mat-dialog-container .agree-actions-group button:last-child',
                              text_match=["Tôi đồng ý", "I agree"]),
  # tile right-click menu -> "Thêm vào câu lệnh" (icon add_2): how references get attached
  "add_to_prompt_menu_item": s('[role="menuitem"]', icon_text="add_2",
                               text_match=["Thêm vào câu lệnh", "Add to prompt"]),
  "show_tile_details_setting": s('mat-slide-toggle button[aria-label*="chi tiết về ô"]',
                                 'mat-slide-toggle button[aria-label*="tile details" i]'),
}
# keys the code can request that we have no guess for yet: left empty (feature skipped)
unknown = """add_component_detail add_component_mobile_close
add_component_mobile_filter_list add_component_mobile_filter_trigger
add_to_prompt_menu_item advanced_menu_add_to_prompt_button advanced_menu_characters_tab
advanced_menu_voices_tab agent_instruction_dialog agent_mode_active agent_panel_close agent_panel_owner
compact_layout_marker edit_link flow_agent_instruction_done_button flow_agent_toggle_button
flow_chat_agent_close_button flow_tab_slider_trigger grid_size_small_button icon_element ingredient_chip_thumbnail
ingredient_image_chip ingredient_remove_button ingredient_video_chip mention_inline_chip page_settings_grid_size
page_settings_grid_view page_settings_root page_settings_trigger reference_picker_project reference_picker_search
reference_picker_thumbnail settings_panel_candidates settings_panel_marker show_tile_details_setting
tab_button_generic tile_error_owner tile_video_owner video_duration_slider video_duration_slider_value
video_duration_tab video_mode_frames video_mode_ingredients video_resolution_tab video_upload_confirm
warning_icon media_viewer_owner prompt_clear_button composer_advanced_menu_button tile_retry_button
tile_error_message tile_display_name project_error_indicator flow_credit_limit_alert new_project_button
model_picker_button ingredient_bar""".split()
for k in unknown:
    flow_selectors.setdefault(k, s('[data-566flow-unmapped]'))

dom = json.load(open(root/"config/dom.json"))
dom["flow"] = {"selectors": {}, "profiles": {"v2": {
    "host_patterns": ["https://flow.google.com"], "selectors": flow_selectors}}}
json.dump(dom, open(root/"config/dom.json", "w"), indent=2, ensure_ascii=False)

api = json.load(open(root/"config/api.json"))
# merge (do NOT overwrite) so ratios/download_resolutions/supports from gen_flow_models.py survive
api.setdefault("flow", {}).setdefault("configs", {})
api["flow"]["configs"].setdefault("flow_v2_driver", {"enabled": True})
api["flow"]["configs"].setdefault("radix_trigger_button_pattern",
                                  "button[id^='radix-'][id$='{suffix}']")
# Flow v2 media is served from flow.google.com/asb/... (images) and
# flow-content.google/{image,video}/<uuid>. Without this key every prompt waited
# 5s for config and then watched results blind until the 120s timeout.
api["flow"]["configs"]["image_url_pattern"] = {"url_substring": "/asb/"}
# needed by the reference-image picker (otherwise "picker_config_missing")
api["flow"]["configs"]["reference_picker_policy"] = {
    "enabled": True, "poll_ms": 100, "settle_ms": 450, "open_timeout_ms": 4000,
    "ack_timeout_ms": 8000, "max_scroll_steps": 40,
    "asb_origins": ["https://flow.google.com"]}
# Network observer: Flow's RPC endpoint (read live from flow.google.com 2026-11-16).
# Motion web runs require a "strong" correlation receipt from this observer.
api["flow"]["configs"]["flow_v2_observer_transport"] = {
    "version": 1, "paths": ["/_/AiSandboxAngularFrontend/data/batchexecute"]}
# Correlation broker: observe gen/task/workflow (Motion runs as "gen"), but keep
# batches sequential (observation_only) so Gen/Tasks behaviour is unchanged.
api["flow"]["configs"]["flow_v2_web_correlation"] = {
    "schema_version": 1,
    "allowed_surfaces": ["gen", "task", "workflow"],
    "allowed_media_types": ["image", "video"],
    "parallel_surfaces": [], "parallel_media_types": [],
    "parallel_max_quantity": {"image": 0, "video": 0},
    "observation_only": True,
    "max_active_operations": 1,
    "observer_ack_timeout_ms": 8000,
    "receipt_timeout_ms": 120000,
    "request_bind_timeout_ms": 30000,
    "attempt_ttl_ms": 1200000,
}
# error banners on Flow (pipe-separated, case-insensitive substring match)
api["flow"]["configs"]["error_patterns"] = {
    "policy_text": "vi phạm chính sách|không thể tạo|policy|violat|couldn't generate|could not generate",
    "quota_text": "hết lượt|hết tín dụng|không đủ tín dụng|quota|out of credits|not enough credits",
    "rate_limit_text": "quá nhiều yêu cầu|thử lại sau|too many requests|try again later|rate limit",
    "captcha_text": "captcha|xác minh rằng bạn không phải|verify you are human",
    "upload_blocked_text": "không thể tải lên|tải lên thất bại|upload failed|couldn't upload|can't upload",
    "image_load_failed_text": "failed to load|không tải được",
}
json.dump(api, open(root/"config/api.json", "w"), indent=2, ensure_ascii=False)

check = """// Paste into DevTools console on https://flow.google.com (project page).
(() => {
  const sel = %s;
  const rows = Object.entries(sel).map(([key, v]) => {
    let n = -1;
    try { n = v.selectors.join(", ") === "[data-566flow-unmapped]" ? -2 : document.querySelectorAll(v.selectors.join(", ")).length; } catch (e) { n = -3; }
    return { key, matches: n === -2 ? "(no selector yet)" : n === -3 ? "(invalid selector)" : n };
  });
  console.table(rows);
  const miss = rows.filter(r => r.matches === 0 || typeof r.matches === "string").map(r => r.key);
  console.log("NEEDS FIXING (" + miss.length + "):", miss.join(", "));
})();
""" % json.dumps(flow_selectors, ensure_ascii=False)
open(root/"tools/flow-selector-check.js", "w").write(check)
print("keys:", len(flow_selectors), "guessed:", sum(1 for v in flow_selectors.values() if v['selectors']!=['[data-566flow-unmapped]']))
