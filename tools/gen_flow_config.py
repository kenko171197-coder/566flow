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
  "tile_container": s('flow-grid-tile-container'),
  "tile_image": s('flow-image-tile img[data-media-id]', 'flow-image-tile img.image',
                  attribute="data-media-id"),
  "tile_video": s('flow-video-tile video'),
  "tile_video_poster": s('flow-video-tile img.thumbnail'),
  "tile_video_owner": s('flow-video-tile'),
  "tile_pending": s('flow-grid-tile-container [role="progressbar"]', 'flow-grid-tile-container mat-progress-bar',
                    'flow-grid-tile-container mat-spinner'),
  "flow_scroll_container": s('cdk-virtual-scroll-viewport'),
  "context_menu": s('.mat-mdc-menu-panel', '[role="menu"]'),
  "menu_item": s('.mat-mdc-menu-item', '[role="menuitem"]'),
  "download_submenu": s('.mat-mdc-menu-panel', '[role="menu"]'),
  "download_submenu_item": s('.mat-mdc-menu-item', '[role="menuitem"]'),
  "model_picker_panel": s('[role="listbox"]', '.mat-mdc-menu-panel'),
  "model_picker_item": s('[role="option"]', '.mat-mdc-menu-item'),
  "icon_element": s('mat-icon'),
  "ingredient_bar": s('flow-add-menu', 'flow-base-prompt-box [class*="ingredient"]'),
  "ingredient_remove_button": s('button[aria-label*="emove"]', 'button[aria-label*="X\u00f3a"]',
                                'flow-add-menu button[aria-label*="close"]', icon_text="close"),
  "ingredient_image_chip": s('flow-add-menu [class*="image"]', '[data-ingredient-kind="image"]'),
  "ingredient_video_chip": s('flow-add-menu [class*="video"]', '[data-ingredient-kind="video"]'),
  "ingredient_chip_thumbnail": s('flow-add-menu img'),
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
  # page state
  "signed_out_indicator": s('a[href*="accounts.google.com/ServiceLogin"]', 'a[href*="accounts.google.com/signin"]'),
  "project_card": s('a[href*="/project/"]'),
  "project_link": s('a[href*="/project/"]'),
  "projects_page": s('main'),
  "project_title": s('flow-editable-text'),
}
# keys the code can request that we have no guess for yet: left empty (feature skipped)
unknown = """add_component_apply_button add_component_detail add_component_listbox add_component_mobile_close
add_component_mobile_filter_list add_component_mobile_filter_trigger add_component_option add_component_root
add_menu_upload_tab add_to_prompt_menu_item advanced_menu_add_to_prompt_button advanced_menu_characters_tab
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
model_picker_button download_menu_trigger add_menu_upload_media_button ingredient_bar""".split()
for k in unknown:
    flow_selectors.setdefault(k, s('[data-566flow-unmapped]'))

dom = json.load(open(root/"config/dom.json"))
dom["flow"] = {"selectors": {}, "profiles": {"v2": {
    "host_patterns": ["https://flow.google.com"], "selectors": flow_selectors}}}
json.dump(dom, open(root/"config/dom.json", "w"), indent=2, ensure_ascii=False)

api = json.load(open(root/"config/api.json"))
api["flow"] = {"configs": {"flow_v2_driver": {"enabled": True},
                           "radix_trigger_button_pattern": "button[id^='radix-'][id$='{suffix}']"}}
json.dump(api, open(root/"config/api.json", "w"), indent=2)

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
