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
  # prompt composer
  "slate_editor": s('div[data-slate-editor="true"][contenteditable="true"]',
                    '[role="textbox"][contenteditable="true"]'),
  "submit_button": s('button[aria-label="Create"]', 'button[aria-label="Generate"]',
                     'button[type="submit"]', icon_text="arrow_forward", button_text="Create"),
  "prompt_clear_button": s('button[aria-label="Clear"]', 'button[aria-label="Clear prompt"]'),
  "composer_advanced_menu_button": s('button[aria-haspopup="menu"][aria-label*="dvanced"]'),
  # tiles (generated results)
  "tile_container": s('[data-tile-id]', 'div[data-index] [data-tile-id]'),
  "tile_pending": s('[data-tile-id] [role="progressbar"]', '[data-tile-id] [aria-busy="true"]'),
  "tile_image": s('[data-tile-id] img'),
  "tile_video": s('[data-tile-id] video'),
  "tile_video_poster": s('[data-tile-id] video[poster]'),
  "tile_retry_button": s('[data-tile-id] button[aria-label*="etry"]'),
  "tile_error_message": s('[data-tile-id] [role="alert"]'),
  "tile_display_name": s('[data-tile-id] [data-name]'),
  # page state
  "signed_out_indicator": s('a[href*="accounts.google.com/ServiceLogin"]',
                            'a[href*="accounts.google.com/signin"]'),
  "project_error_indicator": s('[data-error-page]'),
  "flow_credit_limit_alert": s('[role="alert"]', '[role="alertdialog"]'),
  "flow_scroll_container": s('[data-virtuoso-scroller="true"]', 'main'),
  # navigation / projects
  "new_project_button": s('button[aria-label*="New project"]', 'button[aria-label*="new project"]'),
  "project_card": s('a[href*="/project/"]'),
  "project_link": s('a[href*="/project/"]'),
  "projects_page": s('main'),
  "project_title": s('[data-project-title]', 'h1'),
  # settings / model
  "settings_button": s('button[aria-label*="etting"]', 'button[aria-haspopup="dialog"][aria-label*="etting"]'),
  "model_picker_button": s('button[aria-label*="odel"]'),
  "model_picker_panel": s('[role="listbox"]', '[role="menu"]'),
  "model_picker_item": s('[role="option"]', '[role="menuitemradio"]'),
  "menu_item": s('[role="menuitem"]'),
  "context_menu": s('[role="menu"]'),
  "download_menu_trigger": s('button[aria-label*="ownload"]'),
  "download_submenu": s('[role="menu"]'),
  "download_submenu_item": s('[role="menuitem"]'),
  "add_menu_upload_media_button": s('button[aria-label*="pload"]'),
  "ingredient_bar": s('[data-ingredient-bar]'),
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
warning_icon media_viewer_owner""".split()
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
print("keys:", len(flow_selectors), "guessed:", len(flow_selectors)-len(unknown))
