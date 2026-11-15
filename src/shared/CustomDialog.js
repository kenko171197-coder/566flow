(function(){"use strict";class CustomDialog{constructor(){this._overlay=null}alert(message,options={}){const{title=window.I18n?.t("dialog.notification")||"Notification",type="info",html=false,warningText=null,warningIcon="warning",statusItems=null,icon=null,buttons:customButtons}=options;return new Promise(resolve=>{const defaultButtons=[{label:"OK",primary:true,action:()=>resolve()}];this._show({title,message,type,icon,html,warningText,warningIcon,statusItems,buttons:customButtons||defaultButtons})})}settingsSaveFailure(error){if(this._overlay?.isConnected&&this._overlay.dataset.settingsSaveFailure==="true")return Promise.resolve();const translated=key2=>{const value=window.I18n?.t?.(key2);return value&&value!==key2?value:""};const detail=String(error?.message||error||"");const noSpace=/FILE_ERROR_NO_SPACE|\bENOSPC\b/.test(detail);const quota=error?.name==="QuotaExceededError"||/QUOTA_BYTES|MAX_WRITE_OPERATIONS/.test(detail);const key=noSpace?"settings.saveDiskFull":quota?"settings.saveStorageQuota":detail==="SETTINGS_SYNC_FAILED"?"settings.saveServerFailed":"settings.saveFailedHint";const guidance=translated(key)||translated("albums.saveError");const code=noSpace?"FILE_ERROR_NO_SPACE":quota?"QuotaExceededError":detail.slice(0,1e3);const pending=this.alert([guidance,code].filter(Boolean).join("\n\n"),{title:translated("settings.saveFailedTitle")||translated("common.error"),type:"error",html:false});if(this._overlay)this._overlay.dataset.settingsSaveFailure="true";return pending}videoUploadFailure(message,options={}){if(this._overlay?.isConnected&&this._overlay.dataset.videoUploadFailure==="true")return Promise.resolve();const translated=key=>{const value=window.I18n?.t?.(key);return value&&value!==key?value:null};const title=translated("motionEditor.videoUploadFailed")||translated("common.error")||"";const pending=this.alert(message||title,{title,type:"error",...options,html:false,warningText:translated("motionEditor.getStartedUploadWarning"),warningIcon:"chrome"});if(this._overlay)this._overlay.dataset.videoUploadFailure="true";return pending}confirm(message,options={}){const{title=window.I18n?.t("dialog.confirm")||"Confirm",type="warning",confirmText=window.I18n?.t("common.confirm")||"Confirm",cancelText=window.I18n?.t("common.cancel")||"Cancel",confirmIcon=null,initialFocus="primary",steps=null,warningText=null,warningIcon="warning",statusItems=null,auxiliaryText=null,onAuxiliary=null}=options;return new Promise(resolve=>{this._show({title,message,type,initialFocus,steps,warningText,warningIcon,statusItems,buttons:[{label:cancelText,primary:false,action:()=>resolve(false)},...auxiliaryText&&typeof onAuxiliary==="function"?[{label:auxiliaryText,primary:false,action:()=>{resolve(false);onAuxiliary()}}]:[],{label:confirmText,primary:true,icon:confirmIcon,action:()=>resolve(true)}]})})}confirmResumeOrRerun(message,options={}){const{title=window.I18n?.t("workflow.resumeOrRerunTitle")||"Continue or re-run?",type="info",resumeText=window.I18n?.t("common.continue")||"Continue",rerunText=window.I18n?.t("workflow.rerun")||"Re-run",cancelText=window.I18n?.t("common.cancel")||"Cancel"}=options;return new Promise(resolve=>{this._show({title,message,type,showClose:true,onDismiss:()=>resolve(null),buttons:[{label:cancelText,primary:false,action:()=>resolve(null)},{label:rerunText,primary:false,action:()=>resolve("rerun")},{label:resumeText,primary:true,action:()=>resolve("resume")}]})})}confirmDangerous(message,options={}){const{title=window.I18n?.t("dialog.confirmDangerous")||"Confirm Delete",itemName="",confirmText=window.I18n?.t("common.delete")||"Delete",cancelText=window.I18n?.t("common.cancel")||"Cancel",zIndex=null,showClose=false,confirmIcon=null,closeText="Close"}=options;return new Promise(resolve=>{this._close();this._overlay=document.createElement("div");this._overlay.className="cdialog-overlay";if(Number.isFinite(zIndex))this._overlay.style.zIndex=String(zIndex);this._overlay.innerHTML=`
          <div class="cdialog-box cdialog-compact">
            <div class="cdialog-header">
              <div class="cdialog-icon cdialog-danger-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 3v7m4-7v7"/></svg></div>
              <div class="cdialog-title">${this._escapeHtml(title)}</div>
              ${showClose?`<button type="button" class="cdialog-close cdialog-danger-close" data-action="dismiss" aria-label="${this._escapeHtml(closeText)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`:""}
            </div>
            <div class="cdialog-body">
              ${itemName?`<div class="cdialog-item-name">${this._escapeHtml(itemName)}</div>`:""}
              <div class="cdialog-message">${this._escapeHtml(message)}</div>
            </div>
            <div class="cdialog-footer">
              <button class="cdialog-btn cdialog-btn-secondary" data-action="cancel">
                ${this._escapeHtml(cancelText)}
              </button>
              <button class="cdialog-btn cdialog-btn-danger" data-action="confirm">
                ${confirmIcon==="delete"?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 3v7m4-7v7"/></svg>':""}
                ${this._escapeHtml(confirmText)}
              </button>
            </div>
          </div>
        `;const confirmBtn=this._overlay.querySelector('[data-action="confirm"]');const cancelBtn=this._overlay.querySelector('[data-action="cancel"]');confirmBtn.addEventListener("click",()=>{this._close();resolve(true)});cancelBtn.addEventListener("click",()=>{this._close();resolve(false)});this._overlay.querySelector('[data-action="dismiss"]')?.addEventListener("click",()=>{this._close();resolve(false)});this._escHandler=e=>{if(e.key==="Escape"){this._close();resolve(false)}else if(e.key==="Enter"&&document.activeElement===confirmBtn){this._close();resolve(true)}};document.addEventListener("keydown",this._escHandler);["mousedown","mouseup","pointerdown","pointerup"].forEach(evt=>{this._overlay.addEventListener(evt,e=>e.stopPropagation())});document.body.appendChild(this._overlay);confirmBtn.focus()})}prompt(message,options={}){const{title=window.I18n?.t("dialog.input")||"Input",placeholder="",confirmText=window.I18n?.t("common.ok")||"OK",cancelText=window.I18n?.t("common.cancel")||"Cancel",defaultValue="",icon="info"}=options;return new Promise(resolve=>{this._showPrompt({title,message,icon,placeholder,defaultValue,buttons:[{label:cancelText,primary:false,action:()=>resolve(null)},{label:confirmText,primary:true,action:val=>resolve(val)}]})})}_showPrompt({title,message,placeholder,defaultValue,icon="info",buttons}){this._close();this._overlay=document.createElement("div");this._overlay.className="cdialog-overlay";this._overlay.innerHTML=`
        <div class="cdialog-box">
          <div class="cdialog-header">
            <div class="cdialog-icon cdialog-info">${this._getIcon(icon)}</div>
            <div class="cdialog-title">${this._escapeHtml(title)}</div>
          </div>
          <div class="cdialog-body">
            <div style="margin-bottom: 12px;">${this._escapeHtml(message)}</div>
            <input type="text" class="cdialog-input" placeholder="${this._escapeHtml(placeholder)}" value="${this._escapeHtml(defaultValue)}">
          </div>
          <div class="cdialog-footer">
            ${buttons.map((btn,i)=>`
              <button class="cdialog-btn ${btn.primary?"cdialog-btn-primary":"cdialog-btn-secondary"}" data-idx="${i}">
                ${this._escapeHtml(btn.label)}
              </button>
            `).join("")}
          </div>
        </div>
      `;const input=this._overlay.querySelector(".cdialog-input");this._overlay.querySelectorAll(".cdialog-btn").forEach(btnEl=>{btnEl.addEventListener("click",()=>{const idx=parseInt(btnEl.dataset.idx);const val=input.value.trim();this._close();buttons[idx]?.action(val)})});this._escHandler=e=>{if(e.key==="Escape"){this._close();const cancelBtn=buttons.find(b=>!b.primary);cancelBtn?.action(null)}else if(e.key==="Enter"){this._close();const confirmBtn=buttons.find(b=>b.primary);confirmBtn?.action(input.value.trim())}};document.addEventListener("keydown",this._escHandler);["mousedown","mouseup","pointerdown","pointerup"].forEach(evt=>{this._overlay.addEventListener(evt,e=>e.stopPropagation())});document.body.appendChild(this._overlay);setTimeout(()=>{input.focus();input.select()},10)}_getIcon(type){switch(type){case"flow":return window.ProviderBrandIcons?.get("flow")||this._getIcon("warning");case"chrome":return`<svg width="22" height="22" viewBox="0 0 100 100" aria-hidden="true">
            <path fill="#ea4335" d="M50 0a50 50 0 0 1 43.301 25H50a25 25 0 0 0-21.651 37.5L6.699 25A50 50 0 0 1 50 0Z"/>
            <path fill="#fbbc05" d="M93.301 25A50 50 0 0 1 50 100L71.651 62.5A25 25 0 0 0 50 25Z"/>
            <path fill="#34a853" d="M50 100A50 50 0 0 1 6.699 25L28.349 62.5A25 25 0 0 0 71.651 62.5Z"/>
            <circle cx="50" cy="50" r="24" fill="#fff"/>
            <circle cx="50" cy="50" r="21" fill="#4285f4"/>
          </svg>`;case"upload":return`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 16V3m0 0L7 8m5-5 5 5"></path>
            <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"></path>
          </svg>`;case"warning":return`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>`;case"error":return`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>`;case"success":return`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>`;case"play":return'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="m8 5 11 7-11 7V5Z"/></svg>';case"device":return`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="4" y="3" width="16" height="12" rx="2"></rect>
            <path d="M8 21h8"></path><path d="M12 15v6"></path>
          </svg>`;case"camera-video":return'<span class="cdialog-camera-video-icon" aria-hidden="true"></span>';case"video-creative":return'<span class="cdialog-video-creative-icon" aria-hidden="true"></span>';case"video-gen":return'<span class="cdialog-video-gen-icon" aria-hidden="true"></span>';case"max-speed":return'<svg class="footer-flow-api-flash" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4.5 13H11l-1 9 8.5-11H12l1-9Z"></path></svg>';default:return`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>`}}_show({title,message,type,buttons,icon=null,html=false,showClose=false,onDismiss=null,initialFocus="primary",steps=null,warningText=null,warningIcon="warning",statusItems=null}){this._close();const _dismiss=()=>{this._close();if(typeof onDismiss==="function"){onDismiss();return}const cancelBtn=buttons.find(b=>!b.primary)||buttons[buttons.length-1];cancelBtn?.action()};const _closeIcon='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';this._overlay=document.createElement("div");this._overlay.className="cdialog-overlay";const messageContent=Array.isArray(steps)&&steps.length?`<ol class="cdialog-steps">${steps.map(step=>`<li>${this._escapeHtml(step)}</li>`).join("")}</ol>`:html?message:this._escapeHtml(message);this._overlay.innerHTML=`
        <div class="cdialog-box">
          <div class="cdialog-header">
            <div class="cdialog-icon cdialog-${icon||type}">${this._getIcon(icon||type)}</div>
            <div class="cdialog-title">${this._escapeHtml(title)}</div>
            ${showClose?`<button class="cdialog-close" data-action="dismiss" aria-label="Close" style="margin-left:auto;background:transparent;border:none;color:inherit;opacity:0.6;cursor:pointer;padding:4px;display:flex;border-radius:6px;">${_closeIcon}</button>`:""}
          </div>
          <div class="cdialog-body">${messageContent}${warningText?`<div class="cdialog-inline-warning" role="note">
              <span class="cdialog-inline-warning-icon" aria-hidden="true">${this._getIcon(warningIcon)}</span>
              <p>${this._escapeHtml(warningText)}</p>
            </div>`:""}</div>
          <div class="cdialog-footer">
            ${buttons.map((btn,i)=>`
              <button class="cdialog-btn ${btn.primary?"cdialog-btn-primary":"cdialog-btn-secondary"}${["upload","max-speed"].includes(btn.icon)?" cdialog-btn-with-icon":""}" data-idx="${i}">
                ${btn.icon==="max-speed"?this._getIcon("max-speed"):btn.icon==="upload"?'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V3m0 0L7 8m5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>':""}
                ${this._escapeHtml(btn.label)}
              </button>
            `).join("")}
          </div>
        </div>
      `;if(Array.isArray(statusItems)&&statusItems.length){const list=document.createElement("ul");list.className="cdialog-status-list";for(const item of statusItems){const row=document.createElement("li");row.className="cdialog-status-row";row.dataset.state=["ready","running","paused","failed","complete","pending"].includes(item.state)?item.state:"pending";const dot=document.createElement("span");dot.className="cdialog-status-dot";dot.setAttribute("aria-hidden","true");const name=document.createElement("span");name.className="cdialog-status-name";name.textContent=item.name||"";const label=document.createElement("span");label.className="cdialog-status-label";label.textContent=item.label||"";row.append(dot,name,label);if(item.detail){const detail=document.createElement("small");detail.className="cdialog-status-detail";detail.textContent=item.detail;row.append(detail)}list.append(row)}this._overlay.querySelector(".cdialog-body").append(list)}this._overlay.querySelectorAll(".cdialog-btn").forEach(btnEl=>{btnEl.addEventListener("click",e=>{e.stopPropagation();e.preventDefault();const idx=parseInt(btnEl.dataset.idx);const action=buttons[idx]?.action;this._close();action?.()})});const _closeBtn=this._overlay.querySelector(".cdialog-close");if(_closeBtn){_closeBtn.addEventListener("click",e=>{e.stopPropagation();e.preventDefault();_dismiss()})}this._escHandler=e=>{if(e.key==="Escape"){_dismiss()}};document.addEventListener("keydown",this._escHandler);["mousedown","mouseup","pointerdown","pointerup","click"].forEach(evt=>{this._overlay.addEventListener(evt,e=>e.stopPropagation())});this._overlay.addEventListener("click",e=>{if(e.target===this._overlay){_dismiss()}});document.body.appendChild(this._overlay);if(initialFocus==="none"){const box=this._overlay.querySelector(".cdialog-box");box.tabIndex=-1;box.setAttribute("role","dialog");box.setAttribute("aria-modal","true");box.setAttribute("aria-label",title);box.focus({preventScroll:true})}else{const focusSelector=initialFocus==="cancel"?".cdialog-btn-secondary":".cdialog-btn-primary";this._overlay.querySelector(focusSelector)?.focus()}}_close(){if(this._overlay){if(this._overlay.parentNode){this._overlay.parentNode.removeChild(this._overlay)}else{this._overlay.remove()}this._overlay=null}if(this._escHandler){document.removeEventListener("keydown",this._escHandler);this._escHandler=null}}_escapeHtml(text){const div=document.createElement("div");div.textContent=text||"";return div.innerHTML}}window.CustomDialog=CustomDialog;window.customDialog=new CustomDialog})();
