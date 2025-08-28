
(function(){
  "use strict";
  // Initialize signature button state on page load
  async function initSignatureButton() {
    const signBtn = document.getElementById("btn-sign");
    if (!signBtn) return;
    
    // Check if signature exists in IndexedDB
    if (window.IndexedStorage && window.IndexedStorage.Storage) {
      try {
        const saved = await window.IndexedStorage.Storage.getItem("JL_signature_png");
        if (saved) {
          signBtn.classList.add("btn-green");
        } else {
          signBtn.classList.remove("btn-green");
        }
      } catch (err) {
        console.warn('Failed to load signature state:', err);
        signBtn.classList.remove("btn-green");
      }
    }
  }
  
  // Initialize signature button when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSignatureButton);
  } else {
    initSignatureButton();
  }
  const $ = sel => document.querySelector(sel);
  const on = (el, ev, fn, opts)=> { if(el) el.addEventListener(ev, fn, opts||false); };

  // iOS drag prevention - prevent image zoom/selection but allow drag/click functionality
  function preventIOSImageZoom() {
    // Only prevent context menu on long press for draggable items (but allow touch events)
    document.addEventListener('contextmenu', function(e) {
      const target = e.target;
      if (target.draggable || target.closest('[draggable="true"]') || target.closest('.draggable')) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, false);

    // Only prevent touch events for images to prevent iOS image zoom/selection
    document.addEventListener('touchstart', function(e) {
      const target = e.target;
      // Only prevent for actual IMG elements, not interactive elements like buttons/cards
      if (target.tagName === 'IMG' && target.closest('.tile.card')) {
        e.preventDefault(); // Prevent image selection and zoom
      }
    }, { passive: false });
  }

  // Initialize iOS prevention when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', preventIOSImageZoom);
  } else {
    preventIOSImageZoom();
  }

  // Clean file drop handling - only for actual file drops
  ["dragover","drop"].forEach(function(ev){
    document.addEventListener(ev, async function(e){
      // Only handle file drops, ignore library/workspace drag operations
      if(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length && ev==="drop"){
        e.preventDefault();
        await addFiles(e.dataTransfer.files);
      } else if(!window.__libOpen && !e.dataTransfer.types.includes("text/plain")) {
        // Only prevent default for non-drag operations when library is closed
        e.preventDefault();
      }
    }, {passive:false});
  });

  // Signature pad
  const SIG_KEY = "JL_signature_png";
  const sigModal = $("#sign");
  const sigCanvas = $("#sig-canvas");
  const sigCtx = sigCanvas.getContext("2d", { willReadFrequently:true });
  let sigDrawing = false; let sigDirty = false;
  
  // Signature undo/redo system
  let sigUndoHistory = [];
  let sigCurrentHistoryIndex = -1;
  const SIG_MAX_HISTORY = 20;
  let sigLastActionTime = 0; // Separate debounce timer for signature system
  let sigInitialStateSaved = false; // Flag to prevent duplicate initial state saves
  
  // Save signature state to history
  function saveSignatureState(forceInitial = false) {
    console.log(`[SIG DEBUG] saveSignatureState called, forceInitial=${forceInitial}, sigInitialStateSaved=${sigInitialStateSaved}, currentIndex=${sigCurrentHistoryIndex}, historyLength=${sigUndoHistory.length}`);
    
    const now = Date.now();
    
    // For initial state, ignore debounce but check the flag
    if (forceInitial) {
      if (sigInitialStateSaved) {
        console.log(`[SIG DEBUG] Initial state already saved, returning`);
        return; // Already saved initial state
      }
      sigInitialStateSaved = true;
      console.log(`[SIG DEBUG] Saving initial state`);
    } else {
      if (now - sigLastActionTime < 100) {
        console.log(`[SIG DEBUG] Debounced, returning`);
        return; // Debounce with separate timer
      }
      console.log(`[SIG DEBUG] Saving regular drawing state`);
    }
    
    sigLastActionTime = now;
    
    const imageData = sigCtx.getImageData(0, 0, sigCanvas.width, sigCanvas.height);
    
    // Remove any redo states if we're not at the end
    if (sigCurrentHistoryIndex < sigUndoHistory.length - 1) {
      sigUndoHistory = sigUndoHistory.slice(0, sigCurrentHistoryIndex + 1);
    }
    
    sigUndoHistory.push(imageData);
    
    // Limit history size
    if (sigUndoHistory.length > SIG_MAX_HISTORY) {
      sigUndoHistory.shift();
    } else {
      sigCurrentHistoryIndex++;
    }
    
    console.log(`[SIG DEBUG] State saved, newIndex=${sigCurrentHistoryIndex}, newHistoryLength=${sigUndoHistory.length}`);
    updateSignatureUndoRedoButtons();
  }
  
  // Restore signature state from history
  function restoreSignatureState(historyIndex) {
    console.log(`[SIG DEBUG] restoreSignatureState called with historyIndex=${historyIndex}, currentIndex=${sigCurrentHistoryIndex}, historyLength=${sigUndoHistory.length}`);
    
    if (historyIndex < 0 || historyIndex >= sigUndoHistory.length) {
      console.log(`[SIG DEBUG] Invalid historyIndex, returning`);
      return;
    }
    
    const imageData = sigUndoHistory[historyIndex];
    sigCtx.putImageData(imageData, 0, 0);
    sigCurrentHistoryIndex = historyIndex;
    console.log(`[SIG DEBUG] State restored, newCurrentIndex=${sigCurrentHistoryIndex}`);
    updateSignatureUndoRedoButtons();
  }
  
  // Update signature undo/redo button visibility
  function updateSignatureUndoRedoButtons() {
    const undoBtn = $("#sig-undo");
    const redoBtn = $("#sig-redo");
    
    if (undoBtn) {
      undoBtn.style.display = (sigCurrentHistoryIndex > 0) ? "inline-block" : "none";
    }
    
    if (redoBtn) {
      redoBtn.style.display = (sigCurrentHistoryIndex < sigUndoHistory.length - 1) ? "inline-block" : "none";
    }
  }
  
  // Signature undo/redo actions
  function performSignatureUndo() {
    console.log(`[SIG DEBUG] performSignatureUndo called, currentIndex=${sigCurrentHistoryIndex}, historyLength=${sigUndoHistory.length}`);
    if (sigCurrentHistoryIndex > 0) {
      console.log(`[SIG DEBUG] Undoing from ${sigCurrentHistoryIndex} to ${sigCurrentHistoryIndex - 1}`);
      restoreSignatureState(sigCurrentHistoryIndex - 1);
    } else {
      console.log(`[SIG DEBUG] Cannot undo, already at first state`);
    }
  }
  
  function performSignatureRedo() {
    if (sigCurrentHistoryIndex < sigUndoHistory.length - 1) {
      restoreSignatureState(sigCurrentHistoryIndex + 1);
    }
  }
  
  // Check if signature canvas has any drawing (not blank white)
  function isCanvasDrawn() {
    const imageData = sigCtx.getImageData(0, 0, sigCanvas.width, sigCanvas.height);
    const data = imageData.data;
    
    // Check if any pixel is not white (255,255,255,255)
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255 || data[i + 3] !== 255) {
        return true; // Found non-white pixel, canvas has drawing
      }
    }
    return false; // All pixels are white, canvas is blank
  }

  function resizeCanvasToBox(canvas){
    const box = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio||1);
    canvas.width = Math.max(8, Math.floor(box.width * dpr));
    canvas.height = Math.max(8, Math.floor(box.height * dpr));
    canvas.style.width = box.width + "px";
    canvas.style.height = box.height + "px";
  }
  function openSig(){
    sigDirty=false;
    sigDirty=false;
    sigModal.removeAttribute("hidden");
    resizeCanvasToBox(sigCanvas);
    sigCtx.setTransform(1,0,0,1,0,0);
    sigCtx.fillStyle="#fff"; sigCtx.fillRect(0,0,sigCanvas.width,sigCanvas.height);
    sigCtx.strokeStyle="#000"; sigCtx.lineWidth=2 * (window.devicePixelRatio||1); sigCtx.lineJoin="round"; sigCtx.lineCap="round";
    
    // Initialize undo/redo system
    sigUndoHistory = [];
    sigCurrentHistoryIndex = -1;
    sigInitialStateSaved = false;
    
    // Load signature from IndexedDB
    if (window.IndexedStorage && window.IndexedStorage.Storage) {
      window.IndexedStorage.Storage.getItem(SIG_KEY).then(saved => {
        if(saved){ 
          const im=new Image(); 
          im.onload=function(){ 
            sigCtx.drawImage(im,0,0,sigCanvas.width,sigCanvas.height); 
            // Save initial state to history after loading 
            saveSignatureState(true);
          }; 
          im.src=saved; 
        } else {
          // Save initial blank state to history
          saveSignatureState(true);
        }
      }).catch(err => {
        console.warn('Failed to load signature:', err);
        // Save initial blank state to history
        saveSignatureState(true);
      });
    } else {
      console.warn('IndexedDB not available for loading signature');
      // Save initial blank state to history
      saveSignatureState(true);
    }
    
    // Update undo/redo button visibility
    updateSignatureUndoRedoButtons();
  }
  function closeSig(){ if(document.activeElement) try{document.activeElement.blur();}catch(_){ } sigModal.setAttribute("hidden",""); }
  function canvasPoint(e, canvas){
    const r=canvas.getBoundingClientRect();
    const clientX = (e.touches? e.touches[0].clientX: e.clientX);
    const clientY = (e.touches? e.touches[0].clientY: e.clientY);
    const x = clientX - r.left;
    const y = clientY - r.top;
    const scaleX = canvas.width / r.width;
    const scaleY = canvas.height / r.height;
    
    // Allow drawing beyond all 4 sides for both signature pad and annotation canvas
    const EXTEND_MARGIN = 10;
    const rawX = x * scaleX;
    const rawY = y * scaleY;
    
    // Check if this is signature canvas or annotation canvas (ink canvas)
    const isDrawingCanvas = canvas === sigCanvas || canvas.id === 'ink-canvas';
    
    if (isDrawingCanvas) {
      // Allow drawing beyond all bounds with extended margins
      const minX = -EXTEND_MARGIN;
      const minY = -EXTEND_MARGIN;
      const maxX = canvas.width + EXTEND_MARGIN;
      const maxY = canvas.height + EXTEND_MARGIN;
      
      return { 
        x: Math.max(minX, Math.min(maxX, rawX)), 
        y: Math.max(minY, Math.min(maxY, rawY))
      };
    } else {
      // For other canvases, keep normal bounds
      return { 
        x: Math.max(0, Math.min(canvas.width, rawX)), 
        y: Math.max(0, Math.min(canvas.height, rawY))
      };
    }
  }
  let sigCapturePointerId = null;
  function startSig(e){ 
    sigDrawing=true; sigDirty=true; sigDirty=true; 
    
    // Capture pointer for signature (Task 2)
    if (e.pointerId) {
      try {
        sigCanvas.setPointerCapture(e.pointerId);
        sigCapturePointerId = e.pointerId;
      } catch (err) {
        // Fallback if pointer capture fails
      }
    }
    
    sigCtx.beginPath(); const p=canvasPoint(e,sigCanvas); sigCtx.moveTo(p.x,p.y); e.preventDefault&&e.preventDefault(); 
  }
  function moveSig(e){ if(!sigDrawing) return; const p=canvasPoint(e,sigCanvas); sigCtx.lineTo(p.x,p.y); sigCtx.stroke(); e.preventDefault&&e.preventDefault(); }
  function endSig(){ 
    sigDrawing=false; 
    
    // Release pointer capture for signature (Task 2)
    if (sigCapturePointerId !== null) {
      try {
        sigCanvas.releasePointerCapture(sigCapturePointerId);
      } catch (err) {
        // Ignore if release fails
      }
      sigCapturePointerId = null;
    }
    
    // Only save state if actual drawing occurred
    if (sigDirty) {
      saveSignatureState();
      sigDirty = false; // Reset flag after saving
    }
  }

  on($("#btn-sign"),"click",openSig);
  on($("#sig-close"),"click",closeSig);
  on($("#sig-clear"),"click",function(){ 
    sigCtx.fillStyle="#fff"; 
    sigCtx.fillRect(0,0,sigCanvas.width,sigCanvas.height); 
    sigDirty=false; 
    
    // Clear signature from IndexedDB
    if (window.IndexedStorage && window.IndexedStorage.Storage) {
      window.IndexedStorage.Storage.removeItem(SIG_KEY).catch(err => console.warn('Failed to clear signature:', err));
    }
 
    // Clear signature history
    sigUndoHistory = [];
    sigCurrentHistoryIndex = -1;
    sigInitialStateSaved = false;
    updateSignatureUndoRedoButtons();
    // Save blank state (immediate)
    saveSignatureState(true);
    
    var b=document.getElementById("btn-sign"); 
    if(b){ b.classList.remove("btn-green"); } 
  });
  
  // Add signature undo/redo button handlers
  on($("#sig-undo"), "click", performSignatureUndo);
  on($("#sig-redo"), "click", performSignatureRedo);
  on($("#sig-save"),"click",async function(){ 
    var b=document.getElementById("btn-sign"); 
    var existing=null; 
    
    // Get existing signature
    if (window.IndexedStorage && window.IndexedStorage.Storage) {
      try { existing = await window.IndexedStorage.Storage.getItem(SIG_KEY); } catch(_) { }
    }
    
    // Check if canvas has any drawing instead of relying on sigDirty
    const hasDrawing = isCanvasDrawn();
    
    if(hasDrawing){ 
      // Save signature (now already black on white)
      const signatureData = sigCanvas.toDataURL("image/png");
      if (window.IndexedStorage && window.IndexedStorage.Storage) {
        try { await window.IndexedStorage.Storage.setItem(SIG_KEY, signatureData); } catch(_) { }
      }
      if(b){ b.classList.add("btn-green"); } 
    } else { 
      // No drawing on canvas, remove signature
      if (window.IndexedStorage && window.IndexedStorage.Storage) {
        try { await window.IndexedStorage.Storage.removeItem(SIG_KEY); } catch(_) { }
      }
      if(b){ b.classList.remove("btn-green"); } 
    } 
    closeSig(); 
  });
  ["mousedown","touchstart","pointerdown"].forEach(function(ev){ on(sigCanvas,ev,startSig,{passive:false}); });
  ["mousemove","touchmove","pointermove"].forEach(function(ev){ on(sigCanvas,ev,moveSig,{passive:false}); });
  ["mouseup","mouseleave","touchend","touchcancel","pointerup","pointercancel"].forEach(function(ev){ on(sigCanvas,ev,endSig,{passive:false}); });

  // Settings
  const S = { root: $("#settings-overlay"), save: $("#settings-save"), clear: $("#settings-clear"), close: $("#settings-close"),
    name: $("#set-name"), occ: $("#set-occupation"), phone: $("#set-phone"), mail: $("#set-email") };
  const KSET = "JL_settings_v2"; // Updated version for new fields
    on($("#btn-settings"),"click",function(){
      S.root.removeAttribute("hidden");
      // Load settings from IndexedDB on startup (async)
  if (window.IndexedStorage && window.IndexedStorage.Storage) {
    window.IndexedStorage.Storage.getItem(KSET).then(result => {
      try{ const v=JSON.parse(result||"null"); if(v){ S.name.value=v.name||""; S.occ.value=v.occ||""; S.phone.value=v.phone||""; S.mail.value=v.mail||""; } }catch(_){}
    }).catch(_=>{});
  }
    });
  on(S.close,"click",function(){ S.root.setAttribute("hidden",""); });
  on(S.save,"click",function(){
    // Validate required fields
    const name = S.name.value.trim();
    const email = S.mail.value.trim();
    
    if (!name) {
      alert("Name is required");
      S.name.focus();
      return;
    }
    
    if (!email) {
      alert("Email is required");
      S.mail.focus();
      return;
    }
    
    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      alert("Please enter a valid email address");
      S.mail.focus();
      return;
    }
    
    const v = { name: name, occ: S.occ.value.trim(), phone: S.phone.value.trim(), mail: email };
    if (window.IndexedStorage && window.IndexedStorage.Storage) {
      try{ window.IndexedStorage.Storage.setItem(KSET, JSON.stringify(v)).catch(_=>{}); }catch(_){}
    }
    S.root.setAttribute("hidden","");
  });
  on(S.clear,"click",function(){ if (window.IndexedStorage && window.IndexedStorage.Storage) { try{ window.IndexedStorage.Storage.removeItem(KSET).catch(_=>{}); }catch(_){ } } [S.name,S.occ,S.phone,S.mail].forEach(function(i){ i.value=""; }); });
  // Load settings from IndexedDB on startup (async)
  if (window.IndexedStorage && window.IndexedStorage.Storage) {
    window.IndexedStorage.Storage.getItem(KSET).then(result => {
      try{ const v=JSON.parse(result||"null"); if(v){ S.name.value=v.name||""; S.occ.value=v.occ||""; S.phone.value=v.phone||""; S.mail.value=v.mail||""; } }catch(_){}
    }).catch(_=>{});
  }

  // Board + Editor
  const board = $("#board");
  const addTile = $("#add-tile");
  const fileInput = $("#file-input");
  

  const editor = $("#editor");
  const stage = $("#stage");
  const baseC = $("#base-canvas");
  const hiC   = $("#hi-canvas"); // temp overlay for single-pass highlight
  const inkC  = $("#ink-canvas");
  const overlayC = $("#overlay-canvas"); // for eraser overlay and other UI elements
  const txtLayer = $("#txt-layer");
  const notes = $("#notes");
  const ctxBase = baseC.getContext("2d");
  const ctxHi   = hiC.getContext("2d");
  const ctxInk  = inkC.getContext("2d", { willReadFrequently:true });
  const ctxOverlay = overlayC.getContext("2d");
  let inkDown = false;
  let currentTile = null;
  let tool = "pen";

  // Tools UI
  const toolBtns = document.querySelectorAll(".tool");
  const sizeWrap = $("#size-wrap");
  const sizeInp  = $("#size");
  const swatches = $("#swatches");
  const COLORS = { red:"#FF3B30", yellow:"#FFF200", blue:"#3FB7FF" };
  let color = COLORS.red;
  let lastPenSize=4, lastHiliteSize=18, lastEraseSize=80, lastShapeSize=4;
  let lastPenColor=COLORS.red, lastHiliteColor=COLORS.yellow, lastTextBg="#E53935", lastShapeColor=COLORS.red;
  
  // Shape tool state
  let currentShape = "ellipse"; // ellipse, square, arrow
  let isDashed = false;
  let shapes = []; // Array to store shape objects
  let currentShapePreview = null; // For live preview during drawing
  
  // Undo/Redo History System
  let undoHistory = []; // Array of history states
  let currentHistoryIndex = -1; // Current position in history
  const MAX_HISTORY = 20; // Maximum number of undo states
  let lastActionTime = 0; // Debounce rapid actions
  
  // Save current state to history (debounced)
  function saveToHistory() {
    const now = Date.now();
    if (now - lastActionTime < 100) return; // Debounce rapid actions
    lastActionTime = now;
    
    try {
      // Capture current state
      const inkData = inkC.toDataURL("image/png");
      
      const state = {
        inkData: inkData,
        shapes: shapes.slice(), // Deep copy
        timestamp: now
      };
      
      // Remove any history after current index (if we're not at the end)
      if (currentHistoryIndex < undoHistory.length - 1) {
        undoHistory = undoHistory.slice(0, currentHistoryIndex + 1);
      }
      
      // Add new state
      undoHistory.push(state);
      currentHistoryIndex++;
      
      // Limit history size
      if (undoHistory.length > MAX_HISTORY) {
        undoHistory.shift();
        currentHistoryIndex--;
      }
      
      updateUndoRedoButtons();
      console.log(`History saved (${undoHistory.length} states)`);
    } catch (e) {
      console.warn('Failed to save history state:', e);
    }
  }
  
  // Restore state from history
  function restoreFromHistory(historyIndex) {
    if (historyIndex < 0 || historyIndex >= undoHistory.length) return;
    
    const state = undoHistory[historyIndex];
    
    try {
      // Clear current canvases
      ctxInk.clearRect(0, 0, inkC.width, inkC.height);
      
      // Restore ink canvas
      const img = new Image();
      img.onload = function() {
        ctxInk.drawImage(img, 0, 0, inkC.width, inkC.height);
      };
      img.src = state.inkData;
      
      // Restore shapes
      shapes = state.shapes.slice();
      
      currentHistoryIndex = historyIndex;
      updateUndoRedoButtons();
      console.log(`Restored to history index ${historyIndex}`);
    } catch (e) {
      console.warn('Failed to restore history state:', e);
    }
  }
  
  // Update undo/redo button visibility and state
  function updateUndoRedoButtons() {
    const undoBtn = $("#btn-undo");
    const redoBtn = $("#btn-redo");
    
    // Show/hide undo button
    if (undoBtn) {
      undoBtn.style.display = (currentHistoryIndex > 0) ? "inline-block" : "none";
    }
    
    // Show/hide redo button (only show if there's something to redo)
    if (redoBtn) {
      redoBtn.style.display = (currentHistoryIndex < undoHistory.length - 1) ? "inline-block" : "none";
    }
  }
  
  // Undo action
  function performUndo() {
    if (currentHistoryIndex > 0) {
      restoreFromHistory(currentHistoryIndex - 1);
    }
  }
  
  // Redo action  
  function performRedo() {
    if (currentHistoryIndex < undoHistory.length - 1) {
      restoreFromHistory(currentHistoryIndex + 1);
    }
  }
  
  // Eraser overlay state
  let eraserOverlayVisible = false;
  let lastMousePos = {x: 0, y: 0};

  function updateUIForTool(){
    const showSize = (tool==="pen" || tool==="hilite" || tool==="eraser" || tool==="shape");
    sizeWrap.style.display = showSize ? "flex" : "none";
    const showColors = (tool!=="eraser");
    swatches.style.display = showColors ? "flex" : "none";
    const showShapeControls = (tool==="shape");
    const shapeControls = $("#shape-controls");
    if(shapeControls) shapeControls.style.display = showShapeControls ? "flex" : "none";
    
    // pointer events for text layer only when text tool
    txtLayer.style.pointerEvents = (tool==="text") ? "auto" : "none";
    Array.prototype.slice.call(txtLayer.querySelectorAll('.textbox')).forEach(function(tb){
      tb.style.pointerEvents = (tool==='text') ? 'auto' : 'none';
    });
    
    if(tool==="pen"){ 
      sizeInp.min = "1"; sizeInp.max = "56"; sizeInp.step = "1";
      sizeInp.value=lastPenSize; color=lastPenColor; 
    }
    else if(tool==="hilite"){ 
      sizeInp.min = "4"; sizeInp.max = "56"; sizeInp.step = "1";
      sizeInp.value=lastHiliteSize; color=lastHiliteColor; 
    }
    else if(tool==="eraser"){ 
      sizeInp.min = "4"; sizeInp.max = "220"; sizeInp.step = "1";
      sizeInp.value=lastEraseSize; 
    }
    else if(tool==="text"){ color=lastTextBg; }
    else if(tool==="shape"){ 
      // Update size input range for shapes (1-5px)
      sizeInp.min = "2"; sizeInp.max = "9"; sizeInp.step = "0.5";
      sizeInp.value = lastShapeSize; 
      color = lastShapeColor;
      
      // Sync shape UI state
      const shapeButtons = document.querySelectorAll(".shape-btn");
      const dashedToggle = $("#dashed-toggle");
      
      // Update active shape button
      shapeButtons.forEach(function(btn) {
        btn.classList.remove("active");
        if (btn.getAttribute("data-shape") === currentShape) {
          btn.classList.add("active");
        }
      });
      
      // Update dashed toggle state
      if (dashedToggle) {
        dashedToggle.classList.toggle("active", isDashed);
      }
    }
  }
  toolBtns.forEach(function(b){
    b.addEventListener("click", function(){
      toolBtns.forEach(function(x){ x.classList.remove("active"); });
      b.classList.add("active"); tool = b.getAttribute("data-tool"); updateUIForTool();
    });
  });
  swatches.querySelectorAll(".swatch").forEach(function(btn){
    btn.addEventListener("click", function(){
      const c = btn.getAttribute("data-color");
      if(tool==="text"){ lastTextBg = c; if(activeTextbox){ activeTextbox.style.backgroundColor = hexToRgba(c, .85); } }
      else if(tool==="pen"){ lastPenColor=c; }
      else if(tool==="hilite"){ lastHiliteColor=c; }
      else if(tool==="shape"){ lastShapeColor=c; }
      color = c;
    });
  });
  on(sizeInp,"input",function(){
    if(tool==="shape") {
      const v = Math.max(2, Math.min(9, parseFloat(sizeInp.value)));
      lastShapeSize = v;
    } else if(tool==="pen") {
      const v = Math.max(1, Math.min(56, (sizeInp.value|0)));
      lastPenSize = v;
    } else if(tool==="hilite") {
      const v = Math.max(4, Math.min(56, (sizeInp.value|0)));
      lastHiliteSize = v;
    } else if(tool==="eraser") {
      const v = Math.max(4, Math.min(220, (sizeInp.value|0)));
      lastEraseSize = v;
    }
  });
  
  // Shape UI event listeners
  function initShapeControls() {
    const shapeButtons = document.querySelectorAll(".shape-btn");
    const dashedToggle = $("#dashed-toggle");
    
    shapeButtons.forEach(function(btn) {
      btn.addEventListener("click", function() {
        shapeButtons.forEach(function(b) { b.classList.remove("active"); });
        btn.classList.add("active");
        currentShape = btn.getAttribute("data-shape");
      });
    });
    
    if(dashedToggle) {
      dashedToggle.addEventListener("click", function() {
        isDashed = !isDashed;
        dashedToggle.classList.toggle("active", isDashed);
      });
    }
  }
  
  // Initialize shape controls when DOM is ready
  setTimeout(initShapeControls, 100);
  
  // ESC key to cancel in-progress shapes
  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape" && tool === "shape" && shapeStartPoint) {
      ctxHi.clearRect(0,0,hiC.width,hiC.height);
      shapeStartPoint = null;
      inkIsDown = false;
    }
  });
  function hexToRgba(hex, a){
    const h = hex.replace("#","");
    const r=parseInt(h.substring(0,2),16), g=parseInt(h.substring(2,4),16), b=parseInt(h.substring(4,6),16);
    return "rgba("+r+","+g+","+b+","+a+")";
  }

  function sizeEditorToImage(img){
    // Keep internal pixel resolution at image size; snap display to the stage box
    [baseC,hiC,inkC,overlayC].forEach(function(c){ c.width = img.naturalWidth; c.height = img.naturalHeight; });
}

function fitCanvases(){
  const w = stage.clientWidth, h = stage.clientHeight;
  [baseC,hiC,inkC,overlayC].forEach(function(c){ c.style.width = w+'px'; c.style.height = h+'px'; });
  if(txtLayer){ txtLayer.style.width = w+'px'; txtLayer.style.height = h+'px'; }
}
window.addEventListener('resize', function(){ if(!editor.hasAttribute('hidden')) fitCanvases(); });

  async function openEditor(tile){
    currentTile = tile;
    const rec = await getRecordForTile(tile);
    
    // Check if this is a note card
    if(rec && rec.type === "note") {
      openNoteEditor(tile, rec);
      return;
    }
    
    // Original image editor logic
    editor.removeAttribute("hidden");
    // Prevent background scrolling when annotation editor is open
    document.body.classList.add("annotation-editor-open");
    
    const displayImg = tile.querySelector("img");
    const srcBase = rec && rec.baseUrl ? rec.baseUrl : (displayImg ? displayImg.src : "");
    const im = new Image();
    im.onload = function(){
      sizeEditorToImage(im);
      fitCanvases();
      [ctxBase,ctxHi,ctxInk,ctxOverlay].forEach(function(ctx){ ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,baseC.width,baseC.height); });
      txtLayer.innerHTML="";
      ctxBase.drawImage(im,0,0,baseC.width,baseC.height);
      if(rec && rec.inkUrl){ const i2=new Image(); i2.onload=function(){ ctxInk.drawImage(i2,0,0,baseC.width,baseC.height); }; i2.src=rec.inkUrl; }
      if(rec && Array.isArray(rec.texts)){ rec.texts.forEach(addTextboxFromData); }
      
      // Load saved shapes
      shapes = (rec && Array.isArray(rec.shapes)) ? rec.shapes.slice() : [];
      // Render saved shapes to ink canvas
      shapes.forEach(function(shape) {
        renderShapeToCanvas(ctxInk, shape);
      });
      notes.value = (rec && rec.notes) || "";
      tool="pen";
      toolBtns.forEach(function(x){ x.classList.remove("active"); }); document.querySelector('[data-tool="pen"]').classList.add("active");
      lastPenSize=4; lastHiliteSize=18; lastEraseSize=80; lastShapeSize=4;
      lastPenColor=COLORS.red; lastHiliteColor=COLORS.yellow; lastTextBg="#E53935"; lastShapeColor=COLORS.red;
      currentShape="ellipse"; isDashed=false; shapes=[];
      updateUIForTool();
      
      // Initialize history with starting state
      undoHistory = [];
      currentHistoryIndex = -1;
      setTimeout(saveToHistory, 100); // Save initial state
      updateUndoRedoButtons();
    };
    im.src = srcBase;
  }
  
  function openNoteEditor(tile, rec) {
    const noteEditor = $("#note-editor");
    const noteNameInput = $("#note-name");
    const noteContentInput = $("#note-content");
    
    noteEditor.removeAttribute("hidden");
    noteNameInput.value = rec.name || "";
    noteContentInput.value = rec.content || "";
    
    // Focus the content area
    setTimeout(() => noteContentInput.focus(), 100);
  }
  
  function closeNoteEditor() {
    const noteEditor = $("#note-editor");
    noteEditor.setAttribute("hidden", "");
    currentTile = null;
  }
  function closeEditor(){ 
    if(document.activeElement) try{document.activeElement.blur();}catch(_){ } 
    editor.setAttribute("hidden",""); 
    // Remove background scroll lock when annotation editor closes
    document.body.classList.remove("annotation-editor-open");
    currentTile=null; 
    activeTextbox=null; 
  }

  window.addEventListener("resize", async function(){
    if(!currentTile || editor.hasAttribute("hidden")) return;
    const rec = await getRecordForTile(currentTile);
    const srcBase = rec && rec.baseUrl ? rec.baseUrl : (currentTile.querySelector("img")?.src || "");
    const im = new Image(); im.onload=function(){
      sizeEditorToImage(im);
      ctxBase.clearRect(0,0,baseC.width,baseC.height);
      ctxBase.drawImage(im,0,0,baseC.width,baseC.height);
    }; im.src=srcBase;
  });

  function editorPoint(e, canvas){
    const r=canvas.getBoundingClientRect();
    const clientX = (e.touches? e.touches[0].clientX: e.clientX);
    const clientY = (e.touches? e.touches[0].clientY: e.clientY);
    const x = clientX - r.left;
    const y = clientY - r.top;
    const scaleX = canvas.width / r.width;
    const scaleY = canvas.height / r.height;
    
    // For annotation editor: allow drawing 10px beyond all bounds, but clamp for actual drawing
    const EXTEND_MARGIN = 10;
    const rawX = x * scaleX;
    const rawY = y * scaleY;
    
    // Allow stroke continuation beyond all sides by extending the bounds
    const minX = -EXTEND_MARGIN;
    const minY = -EXTEND_MARGIN;
    const maxX = canvas.width + EXTEND_MARGIN;
    const maxY = canvas.height + EXTEND_MARGIN;
    
    return { 
      x: Math.max(minX, Math.min(maxX, rawX)), 
      y: Math.max(minY, Math.min(maxY, rawY)),
      rect: r
    };
  }

  // Ink / Hilite / Eraser / Shape
  let hilitePts = []; let inkIsDown=false; let shapeStartPoint = null;
  let capturePointerId = null; // For continuous drawing outside canvas
  
  function startInk(e){
    if(tool!=="text"){
      inkIsDown=true;
      
      // Capture pointer for continuous drawing outside canvas (Task 2)
      if (e.pointerId && (tool==="pen" || tool==="hilite" || tool==="eraser")) {
        try {
          inkC.setPointerCapture(e.pointerId);
          capturePointerId = e.pointerId;
        } catch (err) {
          // Fallback if pointer capture fails
        }
      }
      
      const p=editorPoint(e,inkC);
      if(tool==="pen"){
        ctxInk.globalCompositeOperation="source-over"; ctxInk.globalAlpha=1; ctxInk.strokeStyle=lastPenColor; ctxInk.lineWidth=lastPenSize;
        ctxInk.lineJoin="round"; ctxInk.lineCap="round"; ctxInk.beginPath(); ctxInk.moveTo(p.x,p.y);
      } else if(tool==="hilite"){
        hilitePts = [{x:p.x,y:p.y}];
        ctxHi.clearRect(0,0,hiC.width,hiC.height);
      } else if(tool==="shape"){
        shapeStartPoint = {x: p.x, y: p.y};
        ctxHi.clearRect(0,0,hiC.width,hiC.height);
      } else if(tool==="eraser"){
        eraseTouchAt(p.x, p.y, lastEraseSize);
        ctxInk.globalCompositeOperation="destination-out"; ctxInk.globalAlpha=1; ctxInk.strokeStyle="rgba(0,0,0,1)"; ctxInk.lineWidth=lastEraseSize;
        ctxInk.lineJoin="round"; ctxInk.lineCap="round"; ctxInk.beginPath(); ctxInk.moveTo(p.x,p.y);
      }
      e.preventDefault&&e.preventDefault();
    }
  }
  function moveInk(e){
    if(!inkIsDown) return;
    const p=editorPoint(e,inkC);
    if(tool==="pen" || tool==="eraser"){
      if(tool==="eraser") {
        eraseTouchAt(p.x, p.y, lastEraseSize);
        // Update eraser overlay during drag
        ctxOverlay.clearRect(0, 0, overlayC.width, overlayC.height);
        drawEraserOverlay(ctxOverlay, p.x, p.y, lastEraseSize);
        eraserOverlayVisible = true;
      }
      ctxInk.lineTo(p.x,p.y); ctxInk.stroke();
    } else if(tool==="hilite"){
      hilitePts.push({x:p.x,y:p.y});
      ctxHi.clearRect(0,0,hiC.width,hiC.height);
      const ctx=ctxHi;
      ctx.globalCompositeOperation="source-over";
      ctx.globalAlpha=0.18;
      ctx.strokeStyle=lastHiliteColor;
      ctx.lineWidth=lastHiliteSize;
      ctx.lineJoin="round"; ctx.lineCap="round";
      ctx.beginPath();
      for(let i=0;i<hilitePts.length;i++){
        const pt=hilitePts[i];
        if(i===0) ctx.moveTo(pt.x,pt.y); else ctx.lineTo(pt.x,pt.y);
      }
      ctx.stroke();
    } else if(tool==="shape" && shapeStartPoint){
      // Live preview of shape
      ctxHi.clearRect(0,0,hiC.width,hiC.height);
      drawShapePreview(ctxHi, shapeStartPoint, p, currentShape, lastShapeColor, lastShapeSize, isDashed);
      // Track current end point for when we finish the shape
      lastMousePos.x = p.x;
      lastMousePos.y = p.y;
    }
    e.preventDefault&&e.preventDefault();
  }
  function endInk(){
    if(!inkIsDown) return;
    if(tool==="hilite"){
      ctxInk.globalCompositeOperation="source-over";
      ctxInk.globalAlpha=1;
      ctxInk.drawImage(hiC,0,0,baseC.width,baseC.height);
      ctxHi.clearRect(0,0,hiC.width,hiC.height);
      hilitePts = [];
      // Save to history after highlighter stroke
      setTimeout(saveToHistory, 50);
    } else if(tool==="shape" && shapeStartPoint){
      // Complete the shape - save it to shapes array
      const endPoint = lastMousePos.x !== undefined ? lastMousePos : shapeStartPoint;
      const newShape = createShapeObject(shapeStartPoint, endPoint, currentShape, lastShapeColor, lastShapeSize, isDashed);
      if (newShape) {
        shapes.push(newShape);
        // Save to history after shape creation
        setTimeout(saveToHistory, 50);
      }
      
      ctxInk.globalCompositeOperation="source-over";
      ctxInk.globalAlpha=1;
      ctxInk.drawImage(hiC,0,0,baseC.width,baseC.height);
      ctxHi.clearRect(0,0,hiC.width,hiC.height);
      shapeStartPoint = null;
    } else if(tool==="pen") {
      // Save to history after pen stroke
      setTimeout(saveToHistory, 50);
    } else if(tool==="eraser") {
      // Save to history after eraser stroke
      setTimeout(saveToHistory, 50);
    }
    inkIsDown=false;
    ctxInk.globalCompositeOperation="source-over"; ctxInk.globalAlpha=1;
    
    // Release pointer capture (Task 2)
    if (capturePointerId !== null) {
      try {
        inkC.releasePointerCapture(capturePointerId);
      } catch (err) {
        // Ignore if release fails
      }
      capturePointerId = null;
    }
    
    // Hide eraser overlay when done
    if(tool==="eraser") hideEraserOverlay();
  }

  function eraseTouchAt(x,y,size){
    const layerRect = txtLayer.getBoundingClientRect();
    const scaleX = baseC.width / layerRect.width;
    const scaleY = baseC.height / layerRect.height;
    const rx = x/scaleX, ry=y/scaleY;
    
    // Erase textboxes
    const tbs = Array.prototype.slice.call(txtLayer.querySelectorAll(".textbox"));
    tbs.forEach(function(tb){
      const left=parseFloat(tb.style.left||"0"), top=parseFloat(tb.style.top||"0");
      const w=parseFloat(tb.style.width||"240"), h=tb.getBoundingClientRect().height*(1/scaleY);
      if(rx>left && rx<left+w && ry>top && ry<top+h){ tb.remove(); }
    });
    
    // Erase shapes that intersect with the eraser circle
    const eraserRadius = size / 2;
    const tolerance = Math.max(2, eraserRadius);
    
    // Remove shapes that are hit by the eraser
    shapes = shapes.filter(function(shape) {
      return !isShapeHitByPoint(shape, x, y, tolerance);
    });
    
    // Re-render remaining shapes to ink canvas
    refreshShapesOnCanvas();
  }
  
  function isShapeHitByPoint(shape, pointX, pointY, tolerance) {
    if (shape.type === "ellipse") {
      const [cx, cy, rx, ry] = shape.points;
      // Distance from point to ellipse (approximation)
      const dx = pointX - cx;
      const dy = pointY - cy;
      const normalizedDist = Math.sqrt((dx*dx)/(rx*rx) + (dy*dy)/(ry*ry));
      return Math.abs(normalizedDist - 1) * Math.min(rx, ry) <= tolerance;
    } else if (shape.type === "rectangle") {
      const [x, y, width, height] = shape.points;
      // Distance from point to rectangle edges
      const distToLeft = Math.abs(pointX - x);
      const distToRight = Math.abs(pointX - (x + width));
      const distToTop = Math.abs(pointY - y);
      const distToBottom = Math.abs(pointY - (y + height));
      
      // Check if point is near any edge
      const nearVerticalEdge = (pointY >= y - tolerance && pointY <= y + height + tolerance) && 
                               (distToLeft <= tolerance || distToRight <= tolerance);
      const nearHorizontalEdge = (pointX >= x - tolerance && pointX <= x + width + tolerance) && 
                                 (distToTop <= tolerance || distToBottom <= tolerance);
      
      return nearVerticalEdge || nearHorizontalEdge;
    } else if (shape.type === "arrow") {
      const [x1, y1, x2, y2] = shape.points;
      // Distance from point to line segment
      const distToLine = distanceToLineSegment(pointX, pointY, x1, y1, x2, y2);
      return distToLine <= tolerance;
    }
    
    return false;
  }
  
  function distanceToLineSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.sqrt(dx*dx + dy*dy);
    
    if (length === 0) return Math.sqrt((px-x1)*(px-x1) + (py-y1)*(py-y1));
    
    const t = Math.max(0, Math.min(1, ((px-x1)*dx + (py-y1)*dy) / (length*length)));
    const projX = x1 + t*dx;
    const projY = y1 + t*dy;
    
    return Math.sqrt((px-projX)*(px-projX) + (py-projY)*(py-projY));
  }
  
  function refreshShapesOnCanvas() {
    // Since we can't easily separate shapes from freehand ink on the same canvas,
    // we need a different approach. For now, we'll just let the normal eraser
    // handle the visual removal, and the shape array filtering prevents 
    // regeneration on save. This is not perfect but avoids destroying other ink.
    // TODO: In the future, consider using a separate shape layer.
  }

  // Shape drawing functions
  function drawShapePreview(ctx, startPoint, endPoint, shapeType, color, thickness, dashed) {
    const dpr = window.devicePixelRatio || 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness * dpr;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    
    // Set dash pattern if enabled (more gaps for better visibility)
    if (dashed) {
      ctx.setLineDash([3 * dpr, 6 * dpr]);
      ctx.lineDashOffset = 0;
    } else {
      ctx.setLineDash([]);
    }
    
    const dx = endPoint.x - startPoint.x;
    const dy = endPoint.y - startPoint.y;
    
    // Suppress tiny shapes
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3 && shapeType !== "arrow") return;
    if (shapeType === "arrow" && Math.sqrt(dx*dx + dy*dy) < 5) return;
    
    ctx.beginPath();
    
    if (shapeType === "ellipse") {
      const cx = startPoint.x + dx/2;
      const cy = startPoint.y + dy/2;
      const rx = Math.abs(dx/2);
      const ry = Math.abs(dy/2);
      ctx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
    } else if (shapeType === "rectangle") {
      const width = Math.abs(dx);
      const height = Math.abs(dy);
      const x = dx >= 0 ? startPoint.x : startPoint.x - width;
      const y = dy >= 0 ? startPoint.y : startPoint.y - height;
      ctx.rect(x, y, width, height);
    } else if (shapeType === "arrow") {
      drawArrow(ctx, startPoint.x, startPoint.y, endPoint.x, endPoint.y, thickness * dpr, dashed);
    }
    
    ctx.stroke();
    
    // Add 0.5px white border for dashed shapes
    if (dashed) {
      ctx.setLineDash([]); // Solid line for border
      ctx.strokeStyle = "#FFFFFF"; // White border
      ctx.lineWidth = 0.5 * dpr;
      ctx.globalAlpha = 1;
      ctx.stroke();
      ctx.globalAlpha = 0.8; // Reset alpha for main shape
    }
  }
  
  function drawArrow(ctx, x1, y1, x2, y2, thickness, dashed = false) {
    const headLength = thickness * 6;
    const headWidth = thickness * 4;
    
    // Draw shaft (respects dashed setting)
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    
    // Calculate arrowhead
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headAngle = Math.PI / 6; // 30 degrees
    
    // Arrowhead points
    const x3 = x2 - headLength * Math.cos(angle - headAngle);
    const y3 = y2 - headLength * Math.sin(angle - headAngle);
    const x4 = x2 - headLength * Math.cos(angle + headAngle);
    const y4 = y2 - headLength * Math.sin(angle + headAngle);
    
    // Draw arrowhead - ALWAYS SOLID even for dashed arrows
    const originalLineDash = ctx.getLineDash();
    ctx.setLineDash([]); // Force solid lines for arrowhead
    
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x3, y3);
    ctx.moveTo(x2, y2);
    ctx.lineTo(x4, y4);
    ctx.stroke();
    
    // Restore original dash pattern for subsequent drawing
    ctx.setLineDash(originalLineDash);
  }

  // Eraser overlay functions
  function drawEraserOverlay(ctx, x, y, size) {
    const rOuter = size/2;
    const rInner = rOuter - 2; // 2 pixels smaller

    // Fill
    ctx.beginPath();
    ctx.arc(x, y, rOuter, 0, 2*Math.PI);
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.fill();

    // Outer black border
    ctx.beginPath();
    ctx.arc(x, y, rOuter, 0, 2*Math.PI);
    ctx.strokeStyle = "rgba(0,0,0,1)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Inner white border
    ctx.beginPath();
    ctx.arc(x, y, rInner, 0, 2*Math.PI);
    ctx.strokeStyle = "rgba(255,255,255,1)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  
  function updateEraserOverlay(e) {
    if (tool !== "eraser") {
      if (eraserOverlayVisible) {
        ctxOverlay.clearRect(0, 0, overlayC.width, overlayC.height);
        eraserOverlayVisible = false;
      }
      return;
    }
    
    const p = editorPoint(e, overlayC);
    lastMousePos.x = p.x;
    lastMousePos.y = p.y;
    
    ctxOverlay.clearRect(0, 0, overlayC.width, overlayC.height);
    drawEraserOverlay(ctxOverlay, p.x, p.y, lastEraseSize);
    eraserOverlayVisible = true;
  }
  
  function hideEraserOverlay() {
    if (eraserOverlayVisible) {
      ctxOverlay.clearRect(0, 0, overlayC.width, overlayC.height);
      eraserOverlayVisible = false;
    }
  }

  // Shape rendering and storage functions
  function renderShapeToCanvas(ctx, shape) {
    const dpr = window.devicePixelRatio || 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = shape.thickness * dpr;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    
    // Set dash pattern if enabled (more gaps for better visibility)
    if (shape.dashed) {
      ctx.setLineDash([3 * dpr, 6 * dpr]);
      ctx.lineDashOffset = 0;
    } else {
      ctx.setLineDash([]);
    }
    
    ctx.beginPath();
    
    if (shape.type === "ellipse") {
      const [cx, cy, rx, ry] = shape.points;
      ctx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
    } else if (shape.type === "rectangle") {
      const [x, y, width, height] = shape.points;
      ctx.rect(x, y, width, height);
    } else if (shape.type === "arrow") {
      const [x1, y1, x2, y2] = shape.points;
      drawArrow(ctx, x1, y1, x2, y2, shape.thickness * dpr, shape.dashed);
      return; // drawArrow handles its own stroke
    }
    
    ctx.stroke();
    
    // Add 0.5px white border for dashed shapes
    if (shape.dashed) {
      ctx.setLineDash([]); // Solid line for border
      ctx.strokeStyle = "#FFFFFF"; // White border
      ctx.lineWidth = 0.5 * dpr;
      ctx.globalAlpha = 1;
      ctx.stroke();
      ctx.globalAlpha = 1; // Reset alpha
    }
  }

  function createShapeObject(startPoint, endPoint, shapeType, color, thickness, dashed) {
    const dx = endPoint.x - startPoint.x;
    const dy = endPoint.y - startPoint.y;
    
    // Suppress tiny shapes
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3 && shapeType !== "arrow") return null;
    if (shapeType === "arrow" && Math.sqrt(dx*dx + dy*dy) < 5) return null;
    
    let points = [];
    
    if (shapeType === "ellipse") {
      const cx = startPoint.x + dx/2;
      const cy = startPoint.y + dy/2;
      const rx = Math.abs(dx/2);
      const ry = Math.abs(dy/2);
      points = [cx, cy, rx, ry];
    } else if (shapeType === "rectangle") {
      const width = Math.abs(dx);
      const height = Math.abs(dy);
      const x = dx >= 0 ? startPoint.x : startPoint.x - width;
      const y = dy >= 0 ? startPoint.y : startPoint.y - height;
      points = [x, y, width, height];
    } else if (shapeType === "arrow") {
      points = [startPoint.x, startPoint.y, endPoint.x, endPoint.y];
    }
    
    return {
      id: generateUniqueId(),
      type: shapeType,
      points: points,
      color: color,
      thickness: thickness,
      dashed: dashed
    };
  }

  // Note editor event handlers
  on($("#btn-note-close"), "click", closeNoteEditor);
  on($("#btn-note-apply"), "click", async function(){
    if(!currentTile) return;
    const jid = window.Library && Library.getCur && Library.getCur();
    if(!jid){ closeNoteEditor(); return; }
    
    const noteNameInput = $("#note-name");
    const noteContentInput = $("#note-content");
    const id = currentTile.getAttribute("data-card-id");
    
    // Update the note using existing system
    const updatedCard = await Library.upsertItem(jid, id, {
      type: "note",
      name: noteNameInput.value.trim(),
      content: noteContentInput.value.trim()
    });
    
    if(window.AppBoard) await AppBoard.clearAndRenderFrom(jid);
    closeNoteEditor();
  });
  
  on($("#btn-close"), "click", closeEditor);
  on($("#btn-clear"), "click", function(){ 
    ctxInk.clearRect(0,0,inkC.width,inkC.height); 
    shapes = [];
    // Clear history when clearing ink
    undoHistory = [];
    currentHistoryIndex = -1;
    updateUndoRedoButtons();
  });
  on($("#btn-undo"), "click", performUndo);
  on($("#btn-redo"), "click", performRedo);
  on($("#btn-apply"), "click", async function(){
    if(!currentTile) return;
    const jid = window.Library && Library.getCur && Library.getCur();
    if(!jid){ closeEditor(); return; }

    const ink = inkC.toDataURL("image/png");
    const tmp = document.createElement("canvas");
    tmp.width = baseC.width; tmp.height = baseC.height;
    const cx = tmp.getContext("2d");
    cx.drawImage(baseC,0,0,baseC.width,baseC.height);
    cx.drawImage(inkC,0,0,baseC.width,baseC.height);
    
    // Render shapes to composed canvas
    shapes.forEach(function(shape) {
      renderShapeToCanvas(cx, shape);
    });
    
    const texts = readTextboxes();
    texts.forEach(function(tb){
      cx.fillStyle = hexToRgba(tb.bgColor||"#E53935", .85);
      cx.fillRect(tb.x, tb.y, tb.w, tb.h);
      cx.fillStyle = "#000";
      cx.font = tb.fontSize + "px sans-serif";
      let y = tb.y + tb.fontSize * 1.2; // First line baseline
      tb.lines.forEach(function(line){ cx.fillText(line, tb.x+12, y); y += tb.fontSize*1.35; });
    });
    const composed = tmp.toDataURL("image/jpeg",0.92);

    const id = ensureCardId(currentTile);
    const currentRecord = await getRecordForTile(currentTile);
    const rec = await Library.upsertItem(jid, id, {
      composedUrl: composed,
      // keep original base separate to allow future erasing of past ink
      baseUrl: (currentRecord?.baseUrl) || (currentTile.querySelector("img")?.src) || baseC.toDataURL("image/png"),
      inkUrl: ink,
      texts: texts.map(function(t){ const o={}; for(const k in t){ if(k!=="lines") o[k]=t[k]; } return o; }),
      shapes: shapes.slice(), // Save current shapes
      notes: notes.value || "",
      url: composed
    });
    const img = currentTile.querySelector("img");
    if(img) img.src = rec.composedUrl || rec.baseUrl || rec.url;
    if(window.AppBoard) await AppBoard.clearAndRenderFrom(jid);
    closeEditor();
  });

  // Text tool: create textbox on txt-layer interaction (not ink canvas)
  let activeTextbox = null;
  on(txtLayer, "pointerdown", function(e){ if(tool!=="text") return; if(e.target!==txtLayer) return;
    const layer = txtLayer.getBoundingClientRect();
    const x = e.clientX - layer.left;
    const y = e.clientY - layer.top;
    makeTextbox({ xCss:x, yCss:y, wCss: Math.min(360, layer.width - x - 10), text:"", bg:lastTextBg });
    e.preventDefault();
  });

  ["mousedown","touchstart","pointerdown"].forEach(function(ev){ on(inkC, ev, startInk, {passive:false}); });
  ["mousemove","touchmove","pointermove"].forEach(function(ev){ on(inkC, ev, moveInk, {passive:false}); });
  // End ink on various events - but exclude mouseleave for eraser to allow continuous drawing
  function endInkHandler(e) {
    if (tool === "eraser" && (e.type === "mouseleave" || e.type === "pointerleave")) {
      return; // Don't end eraser drawing when leaving canvas
    }
    endInk(e);
  }
  ["mouseup","mouseleave","touchend","touchcancel","pointerup","pointercancel"].forEach(function(ev){ on(inkC, ev, endInkHandler, {passive:false}); });

  // Eraser overlay event listeners
  ["mousemove","pointermove"].forEach(function(ev){ on(inkC, ev, updateEraserOverlay, {passive:false}); });
  ["mouseleave","pointerleave"].forEach(function(ev){ on(inkC, ev, hideEraserOverlay, {passive:false}); });

  function makeTextbox(data){
    const div = document.createElement("div");
    div.className="textbox"; div.contentEditable="true";
    const layer = document.getElementById("txt-layer");
    const css = layer.getBoundingClientRect();
    const scaleX = baseC.width / css.width, scaleY = baseC.height / css.height;
    const xCss = (data.xCss!=null? data.xCss : (data.x||20)/scaleX);
    const yCss = (data.yCss!=null? data.yCss : (data.y||20)/scaleY);
    const wCss = Math.max(160, Math.min((data.wCss!=null? data.wCss : (data.w||240)/scaleX), css.width - xCss - 8));
    div.style.left = xCss + "px"; div.style.top = yCss + "px"; div.style.width = wCss + "px";
    div.style.backgroundColor = hexToRgba(data.bg || lastTextBg, .85);
    div.style.fontSize = "24px";
    div.innerHTML = data.text||"";

    let dragging=false, offX=0, offY=0, pid=0, wasFocused=false, startX=0, startY=0, hasDragged=false;
    div.addEventListener("pointerdown",function(e){ 
      e.stopPropagation(); 
      activeTextbox=div; 
      wasFocused = document.activeElement === div;
      
      // Don't focus immediately - wait for pointerup to determine if it's a click or drag
      dragging=true; 
      hasDragged=false;
      pid=e.pointerId; 
      try{div.setPointerCapture(pid);}catch(_){ } 
      
      // Store start position for drag distance calculation
      startX = e.touches ? e.touches[0].clientX : e.clientX;
      startY = e.touches ? e.touches[0].clientY : e.clientY;
      
      // Calculate offset relative to txtLayer for proper drag handling
      const layer = txtLayer.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      offX = clientX - layer.left - parseFloat(div.style.left); 
      offY = clientY - layer.top - parseFloat(div.style.top); 
    });
    div.addEventListener("pointermove",function(e){ 
      e.stopPropagation();
      if(!dragging) return;
      
      // Get current coordinates from pointer event (handle both mouse and touch)
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      
      // Calculate drag distance to determine if this is a drag or click
      const dragDistance = Math.sqrt(Math.pow(clientX - startX, 2) + Math.pow(clientY - startY, 2));
      if (dragDistance > 5) { // 5px threshold for drag detection
        hasDragged = true;
        
        // Blur textbox on first drag move to dismiss iOS keyboard during drag
        if(wasFocused && document.activeElement === div) {
          div.blur();
          wasFocused = false;
        }
      }
      
      // Only move textbox if we've detected dragging
      if(hasDragged) {
        // Get current txtLayer bounds to handle canvas resize correctly
        const layer = txtLayer.getBoundingClientRect();
        const nx = clientX - layer.left - offX;
        const ny = clientY - layer.top - offY;
        
        // Use current txtLayer dimensions instead of cached css values
        const maxX = txtLayer.clientWidth - div.offsetWidth - 2;
        const maxY = txtLayer.clientHeight - div.offsetHeight - 2;
        
        div.style.left = Math.max(0, Math.min(maxX, nx)) + "px";
        div.style.top  = Math.max(0, Math.min(maxY, ny)) + "px";
      }
      
      e.preventDefault();
    });
    div.addEventListener("pointerup",function(e){ 
      e.stopPropagation(); 
      dragging=false; 
      try{ div.releasePointerCapture(pid); }catch(_){ } 
      
      // Handle focus based on whether this was a click or drag
      if(!hasDragged) {
        // This was a click - focus the textbox for editing
        setTimeout(() => div.focus(), 50);
      } else {
        // This was a drag - don't focus, just leave it positioned
        if(wasFocused) {
          // If it was previously focused, keep it focused after drag
          setTimeout(() => div.focus(), 100);
        }
      }
      
      // Reset drag state
      hasDragged = false;
    });

    const resizeObserver = new ResizeObserver(function(){
      const rect = div.getBoundingClientRect();
      const rLayer = layer.getBoundingClientRect();
      const overflow = (rect.right > rLayer.right - 8);
      if(overflow){ const newW = Math.max(160, rLayer.right - 8 - rect.left); div.style.width = newW + "px"; }
    });
    resizeObserver.observe(div);

    layer.appendChild(div);
    activeTextbox = div;
    div.focus();
  }
  function addTextboxFromData(tb){
    // Convert canvas coordinates back to CSS coordinates
    const layer = document.getElementById("txt-layer");
    const css = layer.getBoundingClientRect();
    const scaleX = baseC.width / css.width, scaleY = baseC.height / css.height;
    const xCss = tb.x / scaleX;
    const yCss = tb.y / scaleY;
    const wCss = tb.w / scaleX;
    makeTextbox({ xCss:xCss, yCss:yCss, wCss:wCss, text:tb.text||"", bg:tb.bgColor||"#E53935" });
  }
  function readTextboxes(){
    const layer = document.getElementById("txt-layer");
    const r = layer.getBoundingClientRect();
    const scaleX = baseC.width / r.width;
    const scaleY = baseC.height / r.height;
    const list = Array.prototype.slice.call(layer.querySelectorAll(".textbox"));
    return list.map(function(div){
      const left = parseFloat(div.style.left||"0");
      const top  = parseFloat(div.style.top||"0");
      const wCss = parseFloat(div.style.width||"240");
      const text = div.innerHTML || "";
      const bg = (function(){
        const rgba = div.style.backgroundColor;
        if(!rgba) return "#E53935";
        const m = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        if(!m) return "#E53935";
        function toHex(n){ n=parseInt(n,10); const h=n.toString(16); return (h.length<2?"0":"")+h; }
        return "#"+toHex(m[1])+toHex(m[2])+toHex(m[3]);
      })();
      const fontSize = 24 * scaleY;
      const cx = document.createElement("canvas").getContext("2d");
      cx.font = fontSize + "px sans-serif";
      const maxW = wCss * scaleX - 24; // Keep 24px internal padding for text wrapping
      const words = text.split(/\s+/), lines=[]; let line="";
      for(let i=0;i<words.length;i++){
        const test = line ? line + " " + words[i] : words[i];
        if(cx.measureText(test).width <= maxW){ line = test; } else { if(line) lines.push(line); line = words[i]; }
      }
      if(line) lines.push(line);
      const h = lines.length * fontSize * 1.35 + fontSize*0.2;
      return { x: left * scaleX, y: top * scaleY, w: wCss * scaleX, h:h, text:text, bgColor:bg, fontSize:fontSize, lines:lines };
    });
  }

  function ensureCardId(tile){
    let id=tile.getAttribute("data-card-id");
    if(!id){ 
      id = generateUniqueId(); 
      tile.setAttribute("data-card-id", id); 
    }
    return id;
  }
  async function getRecordForTile(tile){
    const id = tile.getAttribute("data-card-id");
    const jid = (window.Library && Library.getCur && Library.getCur()) || "";
    if(!id || !jid) return null;
    const arr = await Library.loadItems(jid);
    let rec=null; for(let i=0;i<arr.length;i++){ if(arr[i].id===id){ rec=arr[i]; break; } }
    return rec;
  }

  async function createTile(it){
    const tile=document.createElement("div"); tile.className="tile card";
    tile.setAttribute("data-card-id", it.id);
    tile.style.touchAction = "none";
    
    if(it.type === "note") {
      // Create note tile
      tile.classList.add("note-tile");
      const noteIcon = document.createElement("div");
      noteIcon.className = "note-icon";
      noteIcon.textContent = "📝";
      noteIcon.style.cssText = "display:flex;align-items:center;justify-content:center;height:140px;font-size:48px;background:#E6F0FF;border:2px solid #B2CCFF;";
      
      const label = document.createElement("div");
      label.className = "note-label";
      label.style.cssText = "padding:8px;font-size:12px;font-weight:600;text-align:center;background:#333;color:#fff;border-top:1px solid #ddd;";
      
      // Generate letter for display (temporary - will be calculated properly later)
      const jid = Library.getCur();
      const allItems = await Library.loadItems(jid);
      const noteItems = allItems.filter(item => item.type === "note");
      const noteIndex = noteItems.findIndex(item => item.id === it.id);
      const letter = window.Library && Library.generatePDFLetter ? Library.generatePDFLetter(noteIndex) : String.fromCharCode(65 + noteIndex);
      
      if(it.name && it.name.trim()) {
        label.textContent = `General Notes ${letter}. ${it.name.trim()}`;
      } else {
        label.textContent = `General Notes ${letter}.`;
      }
      
      tile.appendChild(noteIcon);
      tile.appendChild(label);
    } else {
      // Create image tile (original logic)
      const img=document.createElement("img"); img.alt=it.name||""; img.src=(it.composedUrl||it.baseUrl||it.url||"");
      tile.appendChild(img);
    }
    
    const del=document.createElement("button"); del.className="del"; del.textContent="×";
    del.addEventListener("click", async function(e){
      e.stopPropagation();
      const jid = Library.getCur(); if(!jid) return;
      await Library.removeItem(jid, it.id);
      if(window.AppBoard) await AppBoard.clearAndRenderFrom(jid);
    });
    tile.appendChild(del);
    tile.addEventListener("click", function(){ if(window.__libOpen) return; openEditor(tile); });
    return tile;
  }
  

  function generateUniqueId(){
    // Generate crypto-strong UUID using Web Crypto API
    try {
      const array = new Uint8Array(16);
      crypto.getRandomValues(array);
      // Convert to hex string
      return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
    } catch(e) {
      // Fallback for older browsers
      return Date.now().toString(36) + Math.random().toString(36).slice(2);
    }
  }

  function makeUniqueFilename(originalName, existingNames){
    if(!existingNames.includes(originalName)) return originalName;
    
    const dotIndex = originalName.lastIndexOf('.');
    const baseName = dotIndex > 0 ? originalName.slice(0, dotIndex) : originalName;
    const extension = dotIndex > 0 ? originalName.slice(dotIndex) : '';
    
    let counter = 1;
    let uniqueName;
    do {
      uniqueName = `${baseName} (${counter})${extension}`;
      counter++;
    } while(existingNames.includes(uniqueName));
    
    return uniqueName;
  }

  // Image compression utility - IndexedDB optimized for high resolution
  function compressImage(file, targetSizeMB = 0.6, quality = 0.85) {
    return new Promise((resolve) => {
      const targetSizeBytes = targetSizeMB * 1024 * 1024;
      
      // Detect incoming image format and dimensions
      const fileType = file.type || 'image/jpeg';
      const isOriginallyPNG = fileType === 'image/png';
      
      console.log(`Processing ${file.name}: ${(file.size/1024/1024).toFixed(2)}MB, format: ${fileType}`);
      
      // Always attempt optimization - target ~0.6MB for better mobile performance
      if (file.size <= targetSizeBytes && file.size <= 100 * 1024) {
        // Very small files under 100KB can pass through
        console.log(`Small file ${file.name} passed through without compression`);
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsDataURL(file);
        return;
      }

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const img = new Image();
      
      img.onload = function() {
        // Log original dimensions
        const originalWidth = img.width;
        const originalHeight = img.height;
        console.log(`Original dimensions: ${originalWidth}x${originalHeight}`);
        
        // Aggressive optimization for mobile performance - target ~0.6MB
        let { width, height } = img;
        
        // Calculate initial scale reduction (25-30% as specified)
        const scaleReduction = file.size > 2 * 1024 * 1024 ? 0.7 : 0.75; // 30% or 25% reduction
        width = Math.floor(width * scaleReduction);
        height = Math.floor(height * scaleReduction);
        
        console.log(`After scale reduction (${Math.round((1-scaleReduction)*100)}%): ${width}x${height}`);
        
        // Cap maximum dimensions for mobile performance
        const maxDimension = 1600; // Reduced from 2400 for better mobile performance
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = (height * maxDimension) / width;
            width = maxDimension;
          } else {
            width = (width * maxDimension) / height;
            height = maxDimension;
          }
          console.log(`After max dimension cap: ${Math.floor(width)}x${Math.floor(height)}`);
        }
        
        // Minimum size check to maintain usability
        const minDimension = 400;
        if (width < minDimension && height < minDimension) {
          const scale = minDimension / Math.max(width, height);
          width *= scale;
          height *= scale;
          console.log(`After min dimension adjustment: ${Math.floor(width)}x${Math.floor(height)}`);
        }
        
        canvas.width = Math.floor(width);
        canvas.height = Math.floor(height);
        
        // Draw image to canvas
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        
        // Start with good quality, reduce until target size is met
        let currentQuality = quality;
        let result = canvas.toDataURL('image/jpeg', currentQuality);
        
        // Iteratively reduce quality to meet target size (~0.6MB)
        while (result.length * 0.75 > targetSizeBytes && currentQuality > 0.3) {
          currentQuality -= 0.1; // Bigger steps initially for faster convergence
          result = canvas.toDataURL('image/jpeg', currentQuality);
        }
        
        // Fine-tune quality for better results
        while (result.length * 0.75 > targetSizeBytes && currentQuality > 0.1) {
          currentQuality -= 0.05; // Smaller steps for fine-tuning
          result = canvas.toDataURL('image/jpeg', currentQuality);
        }
        
        // If still too big or originally PNG, try PNG format (sometimes smaller for certain images)
        if (result.length * 0.75 > targetSizeBytes || isOriginallyPNG) {
          const pngResult = canvas.toDataURL('image/png');
          if (pngResult.length < result.length || (isOriginallyPNG && pngResult.length * 0.75 <= targetSizeBytes)) {
            result = pngResult;
            console.log(`Switched to PNG format for better compression`);
          }
        }
        
        const finalSizeMB = (result.length * 0.75) / 1024 / 1024;
        const compressionRatio = ((file.size - (result.length * 0.75)) / file.size * 100).toFixed(1);
        console.log(`Image compressed: ${(file.size/1024/1024).toFixed(2)}MB → ${finalSizeMB.toFixed(2)}MB (${compressionRatio}% reduction, quality: ${currentQuality.toFixed(2)})`);
        resolve(result);
      };
      
      // Load the image
      const reader = new FileReader();
      reader.onload = (e) => { img.src = e.target.result; };
      reader.readAsDataURL(file);
    });
  }

  async function addFiles(files){
    const jid = (window.Library && Library.ensureCurrent && await Library.ensureCurrent()) || "";
    const existingItems = (window.Library && Library.loadItems) ? await Library.loadItems(jid) : [];
    const existingNames = existingItems.map(item => item.name || '');
    
    const list = Array.prototype.slice.call(files||[]);
    const compressionPromises = list.map(function(f){
      return new Promise(async function(res, rej){
        try {
          const uniqueName = makeUniqueFilename(f.name, existingNames);
          existingNames.push(uniqueName); // Track for subsequent files in same batch
          
          // Compress image before storing
          const compressedData = await compressImage(f);
          const timestamp = Date.now();
          
          res({
            name: uniqueName, 
            data: compressedData, 
            originalSize: f.size,
            timestamp: timestamp
          }); 
        } catch (error) {
          console.error('Error processing file:', f.name, error);
          // Fallback to regular FileReader if compression fails
          const fr = new FileReader(); 
          fr.onload = function(){ 
            res({
              name: makeUniqueFilename(f.name, existingNames), 
              data: fr.result,
              timestamp: Date.now()
            }); 
          };
          fr.onerror = rej;
          fr.readAsDataURL(f);
        }
      });
    });
    
    try {
      const items = await Promise.all(compressionPromises);
      let successCount = 0;
      let failedCount = 0;
      
      // Process items sequentially to avoid race conditions
      for (const it of items) {
        try {
          const id = generateUniqueId();
          await Library.addItem(jid, id, { 
            id, 
            name: it.name, 
            baseUrl: it.data, 
            url: it.data,
            timestamp: it.timestamp,
            originalSize: it.originalSize
          });
          successCount++;
        } catch (error) {
          console.error('Failed to save item:', it.name, error);
          failedCount++;
        }
      }
      
      if (failedCount > 0) {
        console.warn(`Upload completed: ${successCount} succeeded, ${failedCount} failed due to storage limits`);
        const storageUsed = window.Library && window.Library.getStorageSizeMB ? (await window.Library.getStorageSizeMB()).toFixed(1) : 'unknown';
        alert(`Warning: ${failedCount} files could not be uploaded due to storage limits.\n\nCurrent storage usage: ${storageUsed}MB\n\nTo free up space:\n• Delete old cards from the Library\n• Remove unused Report IDs\n• Clear browser cache`);
      }
      
      if(window.AppBoard) await AppBoard.clearAndRenderFrom(jid);
    } catch (error) {
      console.error('Upload failed:', error);
      alert('Upload failed. Please try again with smaller files.');
    }
  }
  on($("#file-input"), "change", async function(e){ 
    await addFiles(e.target.files); 
    e.target.value = ""; // Clear input to allow same file upload again
  });

  // Old drag code removed - new system in library.js

  // Notes functionality
  async function createNoteCard(){
    const jid = (window.Library && Library.ensureCurrent && await Library.ensureCurrent()) || "";
    if(!jid) return; // Button should be disabled, but double-check
    
    const id = generateUniqueId();
    const noteCard = {
      id: id,
      type: "note",
      content: "",
      name: "",
      createdAt: Date.now()
    };
    
    // Add to library using existing system
    const addedCard = await window.Library.addItem(jid, id, noteCard);
    if(addedCard) {
      // Refresh the board
      if(window.AppBoard) await AppBoard.clearAndRenderFrom(jid);
      // Open editor for the new note
      const newTile = document.querySelector(`[data-card-id="${id}"]`);
      if(newTile) {
        openEditor(newTile);
      }
    }
  }
  
  // Notes button functionality
  on($("#btn-notes"), "click", async function(){
    const jid = (window.Library && Library.ensureCurrent && await Library.ensureCurrent()) || "";
    if(!jid) return; // Should be disabled
    await createNoteCard();
  });
  
  // Update notes button state when job changes
  async function updateNotesButtonState(){
    const notesBtn = $("#btn-notes");
    const jid = (window.library && window.library.getCurrentReportId && window.library.getCurrentReportId()) || "";
    if(notesBtn) {
      notesBtn.disabled = !jid;
      if(!jid) {
        notesBtn.style.opacity = "0.5";
        notesBtn.style.cursor = "not-allowed";
      } else {
        notesBtn.style.opacity = "1";
        notesBtn.style.cursor = "pointer";
      }
    }
  }
  
  // Initial button state
  updateNotesButtonState().catch(console.warn);

  window.AppBoard = {
    clearAndRenderFrom: async function(jid){
      board.innerHTML="";
      
      // Clean up any drag state before re-rendering
      if(window.Library && window.Library.cleanupDragState) {
        window.Library.cleanupDragState();
      }
      
      const items = (window.Library && Library.loadItems) ? await Library.loadItems(jid) : [];
      for (const it of items) {
        const tile = await createTile(it);
        board.appendChild(tile);
        // Add new drag system to each tile
        if(window.Library && Library.addWorkspaceDragToTile){
          Library.addWorkspaceDragToTile(tile);
        }
      }
      
      // Update notes button state after rendering
      updateNotesButtonState();
    }
  };
})();
