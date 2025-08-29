/**
 * Floor Plan Viewer + Pindrops System
 * Manages PDF floor plan extraction, interactive viewing, and pin placement
 */

(function(){
  "use strict";
  
  // Utility functions
  const $ = sel => document.querySelector(sel);
  const on = (el, ev, fn, opts) => { if(el) el.addEventListener(ev, fn, opts||false); };
  
  // Storage key prefixes (will be combined with Report ID)
  const K_FLOORPLANS_PREFIX = "JL_floorplans_";
  const K_PINS_PREFIX = "JL_pins_";
  const K_VERSION = "_v1";
  
  // In-memory pin cache for immediate UI updates (prevents "1 action behind" issue)
  let memoryPinsCache = null;
  
  // Helper to get current Report ID
  function getCurrentReportId() {
    if (window.library && typeof window.library.getCurrentReportId === 'function') {
      return window.library.getCurrentReportId();
    }
    return null;
  }
  
  // Data helpers using unified storage system from library.js with Report ID context
  const read = async (k, d = null) => { 
    try { 
      // Use library.js storage system (IndexedDB)
      if (window.library && typeof window.library.read === 'function') {
        return await window.library.read(k, d);
      }
      // Fallback should not happen in production - IndexedDB should be available
      console.warn(`Library.js not available for reading ${k}, returning default value`);
      return d;
    } catch(e) { 
      console.error(`Failed to read ${k}:`, e);
      return d; 
    } 
  };
  const write = async (k, v) => { 
    try { 
      // Use library.js storage system (IndexedDB)
      if (window.library && typeof window.library.write === 'function') {
        await window.library.write(k, v);
        return;
      }
      // Fallback should not happen in production - IndexedDB should be available
      console.warn(`Library.js not available for writing ${k}`);
    } catch(e) { 
      console.error(`Failed to write ${k}:`, e);
    } 
  };
  
  // Blob URL management for large images
  const blobUrls = new Map();
  
  // Global state flag to prevent card reordering during pin linking
  let isLinkingActive = false;
  
  // Track used colors per floor plan for random selection
  const usedColorsByFloorPlan = new Map();
  
  // Get random unused color for a floor plan
  function getRandomUnusedColor(floorPlanCardId) {
    // Get or initialize used colors for this floor plan
    if (!usedColorsByFloorPlan.has(floorPlanCardId)) {
      usedColorsByFloorPlan.set(floorPlanCardId, new Set());
    }
    
    const usedColors = usedColorsByFloorPlan.get(floorPlanCardId);
    
    // If all colors are used, reset and start over
    if (usedColors.size >= PIN_COLORS.length) {
      console.log('All pin colors used for floor plan', floorPlanCardId, '- resetting color pool');
      usedColors.clear();
    }
    
    // Get available colors
    const availableColors = PIN_COLORS.filter(color => !usedColors.has(color));
    
    // Pick random available color
    const randomIndex = Math.floor(Math.random() * availableColors.length);
    const selectedColor = availableColors[randomIndex];
    
    // Mark color as used
    usedColors.add(selectedColor);
    
    console.log(`Selected random color ${selectedColor} for floor plan ${floorPlanCardId} (${usedColors.size}/${PIN_COLORS.length} colors used)`);
    
    return selectedColor;
  }
  
  // Function to clear pin selection state
  function clearPinSelection() {
    console.log('Clearing pin selection state');
    viewerState.isPlacingPin = false;
    viewerState.selectedUnlinkedPin = null;
    viewerState.justPlacedPinId = null;
  }
  
  function createBlobUrl(base64Data) {
    try {
      // Convert base64 to blob
      const byteCharacters = atob(base64Data.split(',')[1]);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const mimeType = base64Data.split(',')[0].split(':')[1].split(';')[0];
      const blob = new Blob([byteArray], { type: mimeType });
      
      // Create blob URL
      const blobUrl = URL.createObjectURL(blob);
      const blobId = generateId();
      blobUrls.set(blobId, blobUrl);
      
      return { blobId, blobUrl };
    } catch (e) {
      console.error('Failed to create blob URL:', e);
      return null;
    }
  }
  
  function getBlobUrl(blobId) {
    return blobUrls.get(blobId);
  }
  
  function cleanupBlobUrl(blobId) {
    const blobUrl = blobUrls.get(blobId);
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrls.delete(blobId);
    }
  }
  
  function cleanupAllBlobUrls() {
    blobUrls.forEach(url => URL.revokeObjectURL(url));
    blobUrls.clear();
  }

  // Compress image for IndexedDB storage (high quality for crisp PDFs)
  function compressImageForFallback(base64Data) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = function() {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        // Balanced resolution for PDF quality vs file size
        const maxDimension = 2000; // Reduced for reasonable file sizes while maintaining clarity
        let { width, height } = img;
        
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = (height * maxDimension) / width;
            width = maxDimension;
          } else {
            width = (width * maxDimension) / height;
            height = maxDimension;
          }
        }
        
        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(img, 0, 0, width, height);
        
        // Balanced quality JPEG for reasonable file size with good clarity
        const compressedData = canvas.toDataURL('image/jpeg', 0.88);
        console.log(`High-res compressed: ${(base64Data.length/1024/1024).toFixed(2)}MB → ${(compressedData.length/1024/1024).toFixed(2)}MB`);
        resolve(compressedData);
      };
      img.onerror = () => resolve(base64Data); // Fallback to original if compression fails
      img.src = base64Data;
    });
  }
  
  // Load/save functions
  // Report ID-aware storage functions
  const loadFloorPlans = async () => {
    const reportId = getCurrentReportId();
    if (!reportId) {
      console.warn('No active Report ID - returning empty floor plans array');
      return [];
    }
    const key = K_FLOORPLANS_PREFIX + reportId + K_VERSION;
    return await read(key, []);
  };
  
  const saveFloorPlans = async (floorPlans) => {
    const reportId = getCurrentReportId();
    if (!reportId) {
      console.warn('No active Report ID - cannot save floor plans');
      return;
    }
    const key = K_FLOORPLANS_PREFIX + reportId + K_VERSION;
    await write(key, floorPlans || []);
  };
  
  const loadPins = async () => {
    const reportId = getCurrentReportId();
    if (!reportId) {
      console.warn('No active Report ID - returning empty pins array');
      return [];
    }
    const key = K_PINS_PREFIX + reportId + K_VERSION;
    const pins = await read(key, []);
    
    // Update memory cache with fresh data from storage
    memoryPinsCache = pins;
    
    return pins;
  };
  
  // Removed caching system to fix timing issues - use direct loadPins() like reference implementation
  
  const savePins = async (pins) => {
    const reportId = getCurrentReportId();
    if (!reportId) {
      console.warn('No active Report ID - cannot save pins');
      return;
    }
    const key = K_PINS_PREFIX + reportId + K_VERSION;
    await write(key, pins || []);
  };
  
  // Removed all caching functions to eliminate timing and stale data issues
  
  // Generate unique IDs
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }
  
  // Convert normalized coordinates to inches (assumes typical 8.5x11 page)
  function normalizedToInches(x, y) {
    // Standard US letter size: 8.5" x 11"
    const pageWidthInches = 8.5;
    const pageHeightInches = 11;
    
    const xInches = (x * pageWidthInches).toFixed(2);
    const yInches = (y * pageHeightInches).toFixed(2);
    
    return { x: xInches, y: yInches };
  }
  
  // Pin color palette - cleaned up, no duplicates, maximum variety
  const PIN_COLORS = [
    '#3b82f6', // bright blue
    '#22c55e', // bright green  
    '#dc2626', // bright red
    '#FFF200', // bright yellow
    '#8b5cf6', // bright purple
    '#f97316', // bright orange
    '#ec4899', // bright pink
    '#06b6d4', // bright cyan
    '#84cc16', // bright lime
    '#f59e0b', // bright amber
    '#10b981', // emerald
    '#e11d48', // rose
    '#7c3aed', // violet
    '#0d9488', // teal
    '#be185d', // deep pink
    '#4338ca', // indigo
    '#ca8a04', // gold
    '#2563eb', // blue
    '#15803d', // forest green
    '#b45309', // burnt orange
    '#a21caf', // fuchsia
    '#134e4a', // dark teal
    '#713f12', // brown
    '#991b1b', // dark red
    '#14532d', // dark green
    '#86198f', // dark fuchsia
    '#312e81', // dark indigo
    '#155e75', // dark cyan
    '#365314', // dark lime
    '#a16207', // dark yellow
    '#7f1d1d', // maroon
    '#059669', // dark emerald
    '#7c2d12', // dark brown
    '#92400e', // dark orange
    '#c2410c', // red orange
    '#9333ea', // bright violet
    '#65a30d', // yellow green
    '#9a3412', // rust
    '#1e40af', // medium blue
    '#166534'  // medium green
  ];
  
  // Data Models
  
  /**
   * FloorPlanCard: Container for one PDF with multiple extracted plans
   * @typedef {Object} FloorPlanCard
   * @property {string} id - Unique identifier
   * @property {string} reportId - Associated job ID
   * @property {string} filename - Original PDF filename
   * @property {string} pdfSource - 'gallery' or 'sharepoint'
   * @property {Plan[]} plans - Array of extracted floor plans
   * @property {number} createdAt - Timestamp
   * @property {number} updatedAt - Timestamp
   * @property {number} order - Display order
   */
  
  /**
   * Plan: Individual extracted floor plan image
   * @typedef {Object} Plan
   * @property {string} id - Unique identifier
   * @property {string} floorPlanCardId - Parent floor plan card
   * @property {string} src - Base64 or blob URL of extracted image
   * @property {number} width - Image width in pixels
   * @property {number} height - Image height in pixels
   * @property {number} pageIndex - Source PDF page number (0-based)
   * @property {Object} sourceRect - PDF coordinates {x, y, width, height}
   * @property {number} order - Display order within floor plan card
   * @property {string} name - Optional plan name/title
   */
  
  /**
   * Pin: Individual pin with position and optional card linking
   * @typedef {Object} Pin
   * @property {string} id - Unique identifier
   * @property {string} reportId - Associated job ID
   * @property {string} floorPlanCardId - Parent floor plan card
   * @property {string} planId - Specific plan this pin belongs to
   * @property {number} x - Normalized X coordinate (0-1)
   * @property {number} y - Normalized Y coordinate (0-1)
   * @property {string} headColor - Pin head color (hex)
   * @property {string|null} linkedCardId - Optional linked card ID
   * @property {number} createdAt - Timestamp
   */
  
  // Floor Plan Management Functions
  
  async function createFloorPlanCard(reportId, filename, pdfSource = 'gallery') {
    const floorPlanCard = {
      id: generateId(),
      reportId: reportId,
      filename: filename,
      pdfSource: pdfSource,
      plans: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      order: 0
    };
    
    const floorPlans = await loadFloorPlans();
    floorPlans.unshift(floorPlanCard);
    await saveFloorPlans(floorPlans);
    
    return floorPlanCard;
  }
  
  async function getFloorPlanCard(floorPlanCardId) {
    const floorPlans = await loadFloorPlans();
    return floorPlans.find(fp => fp.id === floorPlanCardId);
  }
  
  async function updateFloorPlanCard(floorPlanCardId, updates) {
    const floorPlans = await loadFloorPlans();
    const index = floorPlans.findIndex(fp => fp.id === floorPlanCardId);
    if (index >= 0) {
      floorPlans[index] = { ...floorPlans[index], ...updates, updatedAt: Date.now() };
      await saveFloorPlans(floorPlans);
      return floorPlans[index];
    }
    return null;
  }
  
  async function deleteFloorPlanCard(floorPlanCardId) {
    // Get floor plan card to clean up blob URLs
    const floorPlanCard = await getFloorPlanCard(floorPlanCardId);
    if (floorPlanCard && floorPlanCard.plans) {
      floorPlanCard.plans.forEach(plan => {
        if (plan.blobId) {
          cleanupBlobUrl(plan.blobId);
          console.log('Cleaned up blob URL for plan:', plan.id);
        }
      });
    }
    
    // Remove floor plan card
    const floorPlans = await loadFloorPlans();
    const filteredFloorPlans = floorPlans.filter(fp => fp.id !== floorPlanCardId);
    await saveFloorPlans(filteredFloorPlans);
    
    // Remove associated pins
    const pins = await loadPins();
    const filteredPins = pins.filter(pin => pin.floorPlanCardId !== floorPlanCardId);
    await savePins(filteredPins);
    
    // Clean up used colors tracking for this floor plan
    usedColorsByFloorPlan.delete(floorPlanCardId);
    
    console.log('Deleted floor plan card and associated pins:', floorPlanCardId);
  }
  
  async function addPlanToFloorPlanCard(floorPlanCardId, plan) {
    const floorPlanCard = await getFloorPlanCard(floorPlanCardId);
    if (floorPlanCard) {
      plan.id = generateId();
      plan.floorPlanCardId = floorPlanCardId;
      plan.order = floorPlanCard.plans.length;
      
      // Optimize large images by using blob URLs with compressed fallback
      if (plan.src && plan.src.startsWith('data:') && plan.src.length > 50000) {
        console.log('Large image detected, creating blob URL for plan:', plan.id);
        const blobData = createBlobUrl(plan.src);
        if (blobData) {
          plan.blobId = blobData.blobId;
          plan.blobUrl = blobData.blobUrl;
          // Keep compressed base64 as small fallback (90% smaller than original)
          plan.originalSrc = await compressImageForFallback(plan.src);
          delete plan.src;
          console.log('Optimized plan storage with blob URL and compressed fallback');
        }
      }
      
      floorPlanCard.plans.push(plan);
      updateFloorPlanCard(floorPlanCardId, { plans: floorPlanCard.plans });
      return plan;
    }
    return null;
  }
  
  // Performance optimized batch version for PDF upload
  async function addMultiplePlansToFloorPlanCard(floorPlanCardId, candidates) {
    const floorPlanCard = await getFloorPlanCard(floorPlanCardId);
    if (!floorPlanCard) return [];
    
    console.log(`Batch processing ${candidates.length} PDF pages...`);
    updateFloorPlanCardStatus(floorPlanCardId, `Processing ${candidates.length} pages...`);
    // Small delay to ensure status is visible
    await new Promise(resolve => setTimeout(resolve, 300));
    const newPlans = [];
    
    // Process all candidates in parallel for better performance
    const planPromises = candidates.map(async (candidate, index) => {
      const plan = {
        id: generateId(),
        floorPlanCardId: floorPlanCardId,
        src: candidate.src,
        width: candidate.width,
        height: candidate.height,
        pageIndex: candidate.pageIndex,
        sourceRect: candidate.sourceRect,
        name: candidate.name,
        order: floorPlanCard.plans.length + index
      };
      
      // Optimize large images
      if (plan.src && plan.src.startsWith('data:') && plan.src.length > 50000) {
        console.log(`Optimizing large image for plan ${index + 1}/${candidates.length}`);
        const blobData = createBlobUrl(plan.src);
        if (blobData) {
          plan.blobId = blobData.blobId;
          plan.blobUrl = blobData.blobUrl;
          plan.originalSrc = await compressImageForFallback(plan.src);
          delete plan.src;
        }
      }
      
      return plan;
    });
    
    updateFloorPlanCardStatus(floorPlanCardId, `Saving ${candidates.length} pages to database...`);
    const processedPlans = await Promise.all(planPromises);
    
    // Small delay to show saving status
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Single IndexedDB write for all plans
    floorPlanCard.plans.push(...processedPlans);
    await updateFloorPlanCard(floorPlanCardId, { plans: floorPlanCard.plans });
    
    updateFloorPlanCardStatus(floorPlanCardId, `Successfully loaded ${processedPlans.length} pages`);
    console.log(`Successfully batch processed ${processedPlans.length} PDF pages`);
    return processedPlans;
  }
  
  // Pin Management Functions
  
  async function createPin(reportId, floorPlanCardId, planId, x, y, linkedCardId = null) {
    // Random color selection with floor plan-wide exclusion
    const headColor = getRandomUnusedColor(floorPlanCardId);
    
    const pin = {
      id: generateId(),
      reportId: reportId,
      floorPlanCardId: floorPlanCardId,
      planId: planId,
      x: x,
      y: y,
      headColor: headColor,
      linkedCardId: linkedCardId,
      createdAt: Date.now()
    };
    
    // Update memory cache immediately for instant UI rendering
    if (!memoryPinsCache) {
      memoryPinsCache = await loadPins();
    }
    memoryPinsCache.push(pin);
    
    // Save to storage asynchronously (don't block UI)
    const pins = [...memoryPinsCache]; // Copy to avoid race conditions
    savePins(pins).catch(error => {
      console.error('Failed to save pin to storage:', error);
      // Remove from cache if save failed
      const index = memoryPinsCache.findIndex(p => p.id === pin.id);
      if (index !== -1) {
        memoryPinsCache.splice(index, 1);
      }
    });
    
    return pin;
  }
  
  async function updatePin(pinId, updates) {
    // Update memory cache immediately
    if (memoryPinsCache) {
      const index = memoryPinsCache.findIndex(pin => pin.id === pinId);
      if (index >= 0) {
        memoryPinsCache[index] = { ...memoryPinsCache[index], ...updates };
      }
    }
    
    // Update storage
    const pins = await loadPins();
    const index = pins.findIndex(pin => pin.id === pinId);
    if (index >= 0) {
      pins[index] = { ...pins[index], ...updates };
      await savePins(pins);
      return pins[index];
    }
    return null;
  }
  
  async function deletePin(pinId) {
    // Update memory cache immediately
    if (memoryPinsCache) {
      memoryPinsCache = memoryPinsCache.filter(pin => pin.id !== pinId);
    }
    
    // Update storage
    const pins = await loadPins();
    const filteredPins = pins.filter(pin => pin.id !== pinId);
    await savePins(filteredPins);
    
    // Refresh UI to show updated pin counts
    await renderFloorPlanCards();
    if (currentFloorPlanCard) {
      renderCardTray();
    }
  }
  
  async function getPinsForPlan(planId) {
    // Use memory cache first for immediate rendering, fallback to storage
    let pins;
    if (memoryPinsCache) {
      pins = memoryPinsCache;
    } else {
      pins = await loadPins();
      memoryPinsCache = pins; // Cache for next time
    }
    return pins.filter(pin => pin.planId === planId);
  }
  
  async function getPinsForFloorPlanCard(floorPlanCardId) {
    const pins = await loadPins();
    return pins.filter(pin => pin.floorPlanCardId === floorPlanCardId);
  }
  
  async function unlinkPin(pinId) {
    const result = await updatePin(pinId, { linkedCardId: null });
    // Skip immediate UI refresh to preserve status messages during processing
    if (currentFloorPlanCard) {
      await renderCardTray();
    }
    return result;
  }
  
  async function getCardLinkedPin(cardId, reportId = null) {
    // Use memory cache first for immediate results
    let pins;
    if (memoryPinsCache) {
      pins = memoryPinsCache;
    } else {
      pins = await loadPins();
    }
    return pins.find(pin => {
      const isLinkedToCard = pin.linkedCardId === cardId;
      if (!reportId) return isLinkedToCard;
      return isLinkedToCard && pin.reportId === reportId;
    });
  }
  
  async function linkPinToCard(pinId, cardId) {
    console.log('Linking pin to card:', pinId, cardId);
    
    // Check if card is already linked to any pin (including this one)
    const existingPin = await getCardLinkedPin(cardId);
    if (existingPin) {
      if (existingPin.id === pinId) {
        return existingPin;
      } else {
        // Unlink without triggering UI refresh (we'll do it once at the end)
        await updatePin(existingPin.id, { linkedCardId: null });
      }
    }
    
    const result = await updatePin(pinId, { linkedCardId: cardId });
    
    // Skip immediate UI refresh to preserve status messages during processing
    if (currentFloorPlanCard) {
      await renderCardTray();
    }
    
    return result;
  }
  
  // Handle card deletion - unlink pins but don't delete them
  async function handleCardDeletion(cardId) {
    const pins = await loadPins();
    const affectedPins = pins.filter(pin => pin.linkedCardId === cardId);
    for (const pin of affectedPins) {
      await unlinkPin(pin.id);
    }
  }
  
  // Handle job deletion - remove all floor plans and pins for this job
  async function handleJobDeletion(reportId) {
    // Clean up blob URLs for all floor plans in this job
    const floorPlans = await loadFloorPlans();
    const jobFloorPlans = floorPlans.filter(fp => fp.reportId === reportId);
    jobFloorPlans.forEach(floorPlan => {
      if (floorPlan.plans) {
        floorPlan.plans.forEach(plan => {
          if (plan.blobId) {
            cleanupBlobUrl(plan.blobId);
            console.log('Cleaned up blob URL for plan:', plan.id);
          }
        });
      }
    });
    
    // Remove all floor plans for this job
    const filteredFloorPlans = floorPlans.filter(fp => fp.reportId !== reportId);
    await saveFloorPlans(filteredFloorPlans);
    
    // Remove all pins for this job
    const pins = await loadPins();
    const filteredPins = pins.filter(pin => pin.reportId !== reportId);
    await savePins(filteredPins);
    
    const removedFloorPlans = floorPlans.length - filteredFloorPlans.length;
    const removedPins = pins.length - filteredPins.length;
    
  }
  
  // UI Rendering Functions
  
  async function renderFloorPlanCards() {
    const bucket = $('#floorplan-cards-bucket');
    if (!bucket) return;
    
    // Check if we have an active Report ID
    const currentReportId = getCurrentReportId();
    if (!currentReportId) {
      bucket.innerHTML = '<div style="color:var(--muted);font-size:14px;text-align:center;padding:20px;">Please select a Report to view floor plans</div>';
      return;
    }
    
    const floorPlans = await loadFloorPlans();
    
    // Clear existing content
    bucket.innerHTML = '';
    
    if (floorPlans.length === 0) {
      bucket.innerHTML = '<div style="color:var(--muted);font-size:14px;text-align:center;padding:20px;">No floor plans uploaded for this report yet</div>';
      return;
    }
    
    for (const floorPlan of floorPlans) {
      const floorPlanCard = document.createElement('div');
      floorPlanCard.className = 'floorplan-card';
      floorPlanCard.dataset.floorPlanId = floorPlan.id;
      
      const plansCount = floorPlan.plans.length;
      const pins = await getPinsForFloorPlanCard(floorPlan.id);
      const pinsCount = pins.length;
      
      floorPlanCard.innerHTML = `
        <div class="floorplan-card-header">
          <div class="floorplan-card-title" title="${floorPlan.filename}">${truncateFilename(floorPlan.filename)}</div>
          <div class="floorplan-card-badge">${plansCount} plans</div>
        </div>
        <div class="floorplan-card-meta">${pinsCount} pins</div>
        <div class="floorplan-card-preview">
          ${plansCount > 0 ? '<div style="font-size:12px;">Click to view plans</div>' : '<div style="font-size:12px;">Processing...</div>'}
        </div>
        <button class="floorplan-card-delete" title="Delete Floor Plan">×</button>
      `;
      
      // Click to open viewer
      floorPlanCard.addEventListener('click', async function(e) {
        if (e.target.classList.contains('floorplan-card-delete')) return;
        await openFloorPlanViewer(floorPlan.id);
      });
      
      // Delete button
      floorPlanCard.querySelector('.floorplan-card-delete').addEventListener('click', async function(e) {
        e.stopPropagation();
        if (confirm(`Delete floor plan "${floorPlan.filename}" and all its pins?`)) {
          await deleteFloorPlanCard(floorPlan.id);
          await renderFloorPlanCards();
        }
      });
      
      bucket.appendChild(floorPlanCard);
    }
  }
  
  function truncateFilename(filename, maxLength = 25) {
    if (filename.length <= maxLength) return filename;
    const extension = filename.split('.').pop();
    const nameWithoutExt = filename.substring(0, filename.lastIndexOf('.'));
    const truncatedName = nameWithoutExt.substring(0, maxLength - extension.length - 4) + '...';
    return truncatedName + '.' + extension;
  }
  
  // PDF Processing with extraction
  async function processPDF(file) {
    // Set upload state
    isUploadingFloorPlan = true;
    
    const currentReportId = getCurrentReportId();
    console.log('Current Report ID for floor plan upload:', currentReportId);
    if (!currentReportId) {
      isUploadingFloorPlan = false; // Reset upload state on error
      alert('Please select a Report ID first before uploading floor plans.\n\nGo to the Library tab and select a Report ID, then return to Floor Plans.');
      return null;
    }
    
    // Create floor plan card immediately
    const floorPlanCard = await createFloorPlanCard(currentReportId, file.name);
    
    // Render floor plan cards so the new card appears in DOM for status updates
    await renderFloorPlanCards();
    
    try {
      // Show processing status (now the card exists in DOM)
      updateFloorPlanCardStatus(floorPlanCard.id, 'Processing PDF...');
      
      // Extract floor plans using the extraction engine
      if (!window.PDFExtraction || !window.PDFExtraction.extractFloorPlansFromPDF) {
        throw new Error('PDF extraction module not available. Please refresh the page.');
      }
      
      const candidates = await window.PDFExtraction.extractFloorPlansFromPDF(file, (progress) => {
        updateFloorPlanCardStatus(floorPlanCard.id, progress.message);
      });
      
      
      if (candidates.length === 0) {
        updateFloorPlanCardStatus(floorPlanCard.id, 'No pages found in PDF');
        return floorPlanCard;
      }
      
      // Performance optimized: batch process all pages at once
      await addMultiplePlansToFloorPlanCard(floorPlanCard.id, candidates);
      
      updateFloorPlanCardStatus(floorPlanCard.id, `Loaded ${candidates.length} pages`);
      
      // Show success message for 3 seconds, then refresh the cards display
      setTimeout(() => {
        renderFloorPlanCards();
      }, 3000);
      
      
    } catch (error) {
      console.error('Error processing PDF:', error);
      updateFloorPlanCardStatus(floorPlanCard.id, `Error: ${error.message}`);
    } finally {
      // Reset upload state when processing is complete
      isUploadingFloorPlan = false;
    }
    
    return floorPlanCard;
  }
  
  function updateFloorPlanCardStatus(floorPlanCardId, status) {
    const card = document.querySelector(`[data-floor-plan-id="${floorPlanCardId}"]`);
    if (card) {
      const preview = card.querySelector('.floorplan-card-preview');
      if (preview) {
        preview.innerHTML = `<div style="font-size:12px; padding: 8px; background: #f0f9ff; border-radius: 4px; border: 1px solid #0ea5e9;">${status}</div>`;
        // Force immediate DOM update
        requestAnimationFrame(() => {
          preview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      }
    }
  }
  
  // Floor Plan Viewer Implementation
  let currentFloorPlanCard = null;
  let currentPlanIndex = 0;
  let currentTool = 'pan';
  let isUploadingFloorPlan = false; // Track floor plan upload state
  let viewerState = {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    isDragging: false,
    lastMouseX: 0,
    lastMouseY: 0,
    planImage: null,
    isPlacingPin: false
  };
  
  async function openFloorPlanViewer(floorPlanCardId) {
    const floorPlanCard = await getFloorPlanCard(floorPlanCardId);
    if (!floorPlanCard || !floorPlanCard.plans.length) {
      alert('No floor plans available to view.');
      return;
    }
    
    currentFloorPlanCard = floorPlanCard;
    currentPlanIndex = 0;
    currentTool = 'pan';
    
    // Show viewer modal
    const viewer = $('#floorplan-viewer');
    if (viewer) {
      viewer.removeAttribute('hidden');
      await initializeViewer();
    }
  }
  
  async function initializeViewer() {
    // Reset all state first
    viewerState.isPlacingPin = false;
    viewerState.selectedUnlinkedPin = null;
    viewerState.justPlacedPinId = null;
    
    // Set up UI
    updatePlanCounter();
    updatePlanBadge();
    loadCurrentPlan();
    await renderCardTray();
    
    // Set up event listeners
    setupViewerControls();
    setupCanvasControls();
    setupToolControls();
    
    // Initialize tool state AFTER setting up controls
    await setActiveTool('pan');
  }
  
  function updatePlanCounter() {
    const counter = $('#plan-counter');
    if (counter && currentFloorPlanCard) {
      const current = currentPlanIndex + 1;
      const total = currentFloorPlanCard.plans.length;
      counter.textContent = `${current} of ${total}`;
    }
  }
  
  function updatePlanBadge() {
    const badge = $('#plan-badge');
    if (badge && currentFloorPlanCard) {
      const count = currentFloorPlanCard.plans.length;
      badge.textContent = `${count} plan${count !== 1 ? 's' : ''}`;
    }
  }
  
  function loadCurrentPlan() {
    if (!currentFloorPlanCard || !currentFloorPlanCard.plans[currentPlanIndex]) return;
    
    const plan = currentFloorPlanCard.plans[currentPlanIndex];
    const canvas = $('#floor-canvas');
    const ctx = canvas.getContext('2d');
    
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Load and display plan image
    const img = new Image();
    img.onload = function() {
      viewerState.planImage = img;
      
      // Fit image to canvas
      const container = $('#floor-canvas-container');
      const containerRect = container.getBoundingClientRect();
      
      canvas.width = containerRect.width;
      canvas.height = containerRect.height;
      
      // Calculate scale to fit image
      const scaleX = canvas.width / img.width;
      const scaleY = canvas.height / img.height;
      const scale = Math.min(scaleX, scaleY, 1); // Don't scale up
      
      viewerState.scale = scale;
      viewerState.offsetX = (canvas.width - img.width * scale) / 2;
      viewerState.offsetY = (canvas.height - img.height * scale) / 2;
      
      drawCurrentPlan();
      renderPins();
    };
    
    // Use blob URL if available, otherwise fallback to base64 src or originalSrc
    const imageSource = plan.blobUrl || getBlobUrl(plan.blobId) || plan.src || plan.originalSrc;
    if (!imageSource) {
      console.error('No image source available for plan:', plan.id);
      return;
    }
    
    img.src = imageSource;
  }
  
  function drawCurrentPlan() {
    const canvas = $('#floor-canvas');
    const ctx = canvas.getContext('2d');
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (viewerState.planImage) {
      ctx.save();
      ctx.translate(viewerState.offsetX, viewerState.offsetY);
      ctx.scale(viewerState.scale, viewerState.scale);
      ctx.drawImage(viewerState.planImage, 0, 0);
      ctx.restore();
    }
  }
  
  async function renderPins() {
    const svg = $('#floor-pins-layer');
    if (!svg || !currentFloorPlanCard) return;
    
    // Clear existing pins
    svg.innerHTML = '';
    
    const currentPlan = currentFloorPlanCard.plans[currentPlanIndex];
    if (!currentPlan) return;
    
    const pins = await getPinsForPlan(currentPlan.id);
    
    pins.forEach(pin => {
      const pinElement = createPinElement(pin);
      svg.appendChild(pinElement);
    });
  }
  
  function createPinElement(pin) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.classList.add('pin');
    g.dataset.pinId = pin.id;
    
    // Convert normalized coordinates to screen coordinates
    const canvas = $('#floor-canvas');
    const screenX = viewerState.offsetX + (pin.x * viewerState.planImage.width * viewerState.scale);
    const screenY = viewerState.offsetY + (pin.y * viewerState.planImage.height * viewerState.scale);
    
    g.setAttribute('transform', `translate(${screenX}, ${screenY})`);
    
    // Pin shaft (black line) - 1.2x larger, reverted to original position
    const shaft = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    shaft.setAttribute('x1', '0');
    shaft.setAttribute('y1', '0');   // Original position
    shaft.setAttribute('x2', '0');
    shaft.setAttribute('y2', '-24'); // 24px shaft length (20 * 1.2)
    shaft.setAttribute('stroke', '#000');
    shaft.setAttribute('stroke-width', '4');  // 3 * 1.2 = 3.6, rounded to 4
    shaft.setAttribute('stroke-linecap', 'round');
    
    // Pin head (colored circle) - 1.2x larger
    const head = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    head.setAttribute('cx', '0');
    head.setAttribute('cy', '-24');  // Original position with 1.2x scaling
    head.setAttribute('r', '10');    // 8 * 1.2 = 9.6, rounded to 10
    head.setAttribute('fill', pin.headColor);
    head.setAttribute('stroke', '#000');
    head.setAttribute('stroke-width', '2.4');  // 2 * 1.2
    
    g.appendChild(shaft);
    g.appendChild(head);
    
    // Add click handler with improved state management and toggle behavior
    g.addEventListener('click', async (e) => {
      e.stopPropagation();
      
      if (currentTool === 'eraser') {
        await deletePin(pin.id);
        renderPins();
        await renderCardTray();
        return;
      }
      
      // Get fresh pin data to avoid stale state (like reference implementation) 
      const pins = await loadPins();
      const freshPin = pins.find(p => p.id === pin.id);
      if (!freshPin) {
        console.warn('Pin not found:', pin.id);
        return;
      }
      
      // Check if this pin is already selected - implement toggle behavior
      const isAlreadySelected = viewerState.selectedUnlinkedPin === freshPin.id || 
                                viewerState.justPlacedPinId === freshPin.id ||
                                (viewerState.isPlacingPin && viewerState.justPlacedPinId === freshPin.id);
      
      // Check if popover is currently showing for this pin
      const popover = $('#pin-popover');
      const isPopoverVisible = popover && !popover.hasAttribute('hidden');
      const popoverForThisPin = isPopoverVisible && 
        (viewerState.selectedUnlinkedPin === freshPin.id || viewerState.justPlacedPinId === freshPin.id);
      
      // Toggle behavior: if pin is already selected and popover is visible, close it
      if (isAlreadySelected && popoverForThisPin) {
        hidePinPopover(true); // Close popover and clear selection
        return;
      }
      
      // Clear pin placement state but preserve selection if appropriate
      viewerState.isPlacingPin = false;
      
      // Always allow pin selection for card linking/replacement - regardless of current link status
      viewerState.selectedUnlinkedPin = freshPin.id;
      viewerState.justPlacedPinId = null; // Clear just placed state
      
      // Update UI and show popover with fresh data
      updateCardTrayHighlight();
      updateTrayHint();
      showPinPopover(freshPin, e);
    });
    
    return g;
  }
  
  function setupViewerControls() {
    // Close button
    const closeBtn = $('#floor-viewer-close');
    if (closeBtn) {
      closeBtn.onclick = closeFloorPlanViewer;
    }
    
    // Navigation buttons
    const prevBtn = $('#plan-prev');
    const nextBtn = $('#plan-next');
    
    if (prevBtn) {
      prevBtn.onclick = () => {
        if (currentPlanIndex > 0) {
          hidePinPopover(true); // Close popover when changing plans
          currentPlanIndex--;
          updatePlanCounter();
          loadCurrentPlan();
        }
      };
    }
    
    if (nextBtn) {
      nextBtn.onclick = () => {
        if (currentFloorPlanCard && currentPlanIndex < currentFloorPlanCard.plans.length - 1) {
          hidePinPopover(true); // Close popover when changing plans
          currentPlanIndex++;
          updatePlanCounter();
          loadCurrentPlan();
        }
      };
    }
  }
  
  function setupCanvasControls() {
    const canvas = $('#floor-canvas');
    if (!canvas) return;
    
    // Mouse events for pan and pin placement
    canvas.addEventListener('mousedown', handleCanvasMouseDown);
    canvas.addEventListener('mousemove', handleCanvasMouseMove);
    canvas.addEventListener('mouseup', handleCanvasMouseUp);
    canvas.addEventListener('wheel', handleCanvasWheel);
    
    // Touch events for mobile
    canvas.addEventListener('touchstart', handleCanvasTouchStart);
    canvas.addEventListener('touchmove', handleCanvasTouchMove);
    canvas.addEventListener('touchend', handleCanvasTouchEnd);
  }
  
  function setupToolControls() {
    const toolBtns = document.querySelectorAll('[data-floor-tool]');
    
    toolBtns.forEach(btn => {
      // Remove any existing listeners to prevent duplicates
      btn.removeEventListener('click', btn._toolClickHandler);
      
      // Create new handler and store reference for removal
      btn._toolClickHandler = async () => {
        const tool = btn.getAttribute('data-floor-tool');
        await setActiveTool(tool);
      };
      
      btn.addEventListener('click', btn._toolClickHandler);
    });
  }
  
  async function setActiveTool(tool) {
    console.log('Setting active tool:', tool, 'current tool:', currentTool);
    
    // Validate tool
    const validTools = ['pan', 'pindrop', 'eraser'];
    if (!validTools.includes(tool)) {
      console.warn('Invalid tool:', tool, 'defaulting to pan');
      tool = 'pan';
    }
    
    // If clicking the same tool (except pan), toggle it off (return to pan mode)
    if (currentTool === tool && tool !== 'pan') {
      currentTool = 'pan';
    } else {
      currentTool = tool;
    }
    
    console.log('Tool switched to:', currentTool);
    
    // ONLY clear pin placement mode when explicitly switching away from pindrop
    // but preserve linking states (isPlacingPin, selectedUnlinkedPin, justPlacedPinId) 
    // until card selection or cancellation
    // This allows users to place a pin, switch to pan tool, and still link to cards
    // Note: isPlacingPin should stay true after pin placement until linking completes
    
    // Update button states - only show active for non-pan tools
    const toolBtns = document.querySelectorAll('[data-floor-tool]');
    toolBtns.forEach(btn => {
      btn.classList.remove('active');
      const btnTool = btn.getAttribute('data-floor-tool');
      if (btnTool === currentTool && currentTool !== 'pan') {
        btn.classList.add('active');
      }
    });
    
    // Update canvas cursor
    const canvas = $('#floor-canvas');
    if (canvas) {
      switch (currentTool) {
        case 'pan':
          canvas.style.cursor = 'grab';
          break;
        case 'pindrop':
          canvas.style.cursor = 'crosshair';
          break;
        case 'eraser':
          canvas.style.cursor = 'pointer';
          break;
        default:
          canvas.style.cursor = 'grab';
      }
    }
    
    // Update UI
    await updateCardTrayHighlight();
    updateTrayHint();
  }
  
  // Debouncing for updateCardTrayHighlight to prevent excessive calls
  let highlightTimeout = null;
  const updateCardTrayHighlightDebounced = (delay = 50) => {
    if (highlightTimeout) {
      clearTimeout(highlightTimeout);
    }
    highlightTimeout = setTimeout(() => {
      updateCardTrayHighlight();
    }, delay);
  };

  // Throttling for canvas redraw during dragging to improve performance
  let lastDrawTime = 0;
  const throttledDrawAndRender = (minInterval = 16) => { // ~60fps max
    const now = Date.now();
    if (now - lastDrawTime >= minInterval) {
      drawCurrentPlan();
      renderPins();
      lastDrawTime = now;
    }
  };
  
  async function updateCardTrayHighlight() {
    const trayCards = document.querySelectorAll('.tray-card');
    const shouldHighlight = viewerState.isPlacingPin || viewerState.selectedUnlinkedPin;
    
    // Update global linking state to prevent card reordering
    const wasLinkingActive = isLinkingActive;
    isLinkingActive = shouldHighlight;
    
    // If linking state changed, update library card drag states
    if (wasLinkingActive !== isLinkingActive && window.library && window.library.renderLibrary) {
      setTimeout(() => window.library.renderLibrary(), 0);
    }
    
    if (shouldHighlight) {
      // Get all pins to check which cards already have links
      const pins = await loadPins();
      const linkedCardIds = new Set(pins.filter(pin => pin.linkedCardId).map(pin => pin.linkedCardId));
      
      for (const card of trayCards) {
        const cardId = card.dataset.cardId;
        // Only highlight cards that DON'T already have pins linked to them
        if (!linkedCardIds.has(cardId)) {
          card.classList.add('danger-highlight');
        } else {
          card.classList.remove('danger-highlight');
        }
      }
    } else {
      // Remove highlight from all cards when not in pin selection mode
      for (const card of trayCards) {
        card.classList.remove('danger-highlight');
      }
    }
  }
  
  function updateTrayHint() {
    const hint = $('#tray-hint');
    if (!hint) return;
    
    if (viewerState.isPlacingPin) {
      hint.textContent = 'Press a card on the right to attach.';
    } else if (viewerState.selectedUnlinkedPin) {
      hint.textContent = 'Press a card on the right to attach.';
    } else {
      switch (currentTool) {
        case 'pan':
          hint.textContent = 'Pan and zoom mode (default)';
          break;
        case 'pindrop':
          hint.textContent = 'Click plan to place pin';
          break;
        case 'eraser':
          hint.textContent = 'Click pins to delete them';
          break;
      }
    }
  }
  
  function handleCanvasMouseDown(e) {
    // Store mouse down position for all tools (needed for drag threshold)
    viewerState.lastMouseX = e.clientX;
    viewerState.lastMouseY = e.clientY;
    viewerState.mouseDownX = e.clientX;
    viewerState.mouseDownY = e.clientY;
    
    // Only pan and eraser tools start dragging immediately
    if (currentTool === 'pan' || currentTool === 'eraser') {
      viewerState.isDragging = true;
      e.target.style.cursor = currentTool === 'eraser' ? 'pointer' : 'grabbing';
      
      // Close pin popover and clear pin selection states when dragging starts
      hidePinPopover(true);
      
      if (viewerState.selectedUnlinkedPin || viewerState.justPlacedPinId || viewerState.isPlacingPin) {
        viewerState.selectedUnlinkedPin = null;
        viewerState.justPlacedPinId = null;
        viewerState.isPlacingPin = false;
        updateCardTrayHighlight();
        updateTrayHint();
      }
    }
    // Pindrop tool: wait for drag threshold to start dragging
  }
  
  
  function handleCanvasMouseMove(e) {
    // Check drag threshold for pindrop tool
    if (currentTool === 'pindrop' && !viewerState.isDragging && viewerState.mouseDownX !== undefined) {
      const dragDistance = Math.sqrt(
        Math.pow(e.clientX - viewerState.mouseDownX, 2) + 
        Math.pow(e.clientY - viewerState.mouseDownY, 2)
      );
      
      // Start dragging if moved more than 5px
      if (dragDistance > 5) {
        viewerState.isDragging = true;
        e.target.style.cursor = 'grabbing';
        
        // Close pin popover and clear pin selection states when starting to drag
        hidePinPopover(true);
        
        if (viewerState.selectedUnlinkedPin || viewerState.justPlacedPinId || viewerState.isPlacingPin) {
          viewerState.selectedUnlinkedPin = null;
          viewerState.justPlacedPinId = null;
          viewerState.isPlacingPin = false;
          // Use debounced version for better performance during dragging
          updateCardTrayHighlightDebounced(200);
          updateTrayHint();
        }
      }
    }
    
    // Handle dragging for all tools
    if (viewerState.isDragging && (currentTool === 'pan' || currentTool === 'eraser' || currentTool === 'pindrop')) {
      const deltaX = e.clientX - viewerState.lastMouseX;
      const deltaY = e.clientY - viewerState.lastMouseY;
      
      // Allow panning for all tools when dragging
      viewerState.offsetX += deltaX;
      viewerState.offsetY += deltaY;
      
      viewerState.lastMouseX = e.clientX;
      viewerState.lastMouseY = e.clientY;
      
      throttledDrawAndRender();
    }
  }
  
  async function handleCanvasMouseUp(e) {
    const wasNotDragging = !viewerState.isDragging;
    
    if (currentTool === 'pan' || currentTool === 'eraser' || currentTool === 'pindrop') {
      viewerState.isDragging = false;
      viewerState.mouseDownX = undefined; // Reset drag threshold tracking
      viewerState.mouseDownY = undefined;
      e.target.style.cursor = currentTool === 'eraser' ? 'pointer' : (currentTool === 'pindrop' ? 'crosshair' : 'grab');
      
      // For pindrop tool: place pin if we didn't drag
      if (currentTool === 'pindrop' && wasNotDragging) {
        // Clear any existing pin selection state first
        if (viewerState.selectedUnlinkedPin || viewerState.justPlacedPinId || viewerState.isPlacingPin) {
          viewerState.selectedUnlinkedPin = null;
          viewerState.justPlacedPinId = null;
          viewerState.isPlacingPin = false;
          updateCardTrayHighlight();
          updateTrayHint();
          console.log('Cleared previous pin selection before placing new pin');
        }
        await placePinAtPosition(e);
        return; // Early return to avoid clearing pin selection
      }
      
      // Click-to-cancel: Clear pin selection states when clicking empty area (but not when placing pins)
      if (currentTool !== 'pindrop' && (viewerState.selectedUnlinkedPin || viewerState.justPlacedPinId || viewerState.isPlacingPin)) {
        viewerState.selectedUnlinkedPin = null;
        viewerState.justPlacedPinId = null;
        viewerState.isPlacingPin = false;
        updateCardTrayHighlight();
        updateTrayHint();
        console.log('Cleared pin selection - clicked empty floor plan area');
      }
    }
  }
  
  function handleCanvasWheel(e) {
    e.preventDefault();
    
    // Close pin popover when zooming (viewport interaction)
    hidePinPopover(true);
    
    const rect = e.target.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.1, Math.min(5, viewerState.scale * zoomFactor));
    
    // Zoom towards mouse position
    const scaleChange = newScale / viewerState.scale;
    viewerState.offsetX = mouseX - (mouseX - viewerState.offsetX) * scaleChange;
    viewerState.offsetY = mouseY - (mouseY - viewerState.offsetY) * scaleChange;
    viewerState.scale = newScale;
    
    drawCurrentPlan();
    renderPins();
  }
  
  async function placePinAtPosition(e) {
    if (!currentFloorPlanCard || !viewerState.planImage) return;
    
    const rect = e.target.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;
    
    // Convert screen coordinates to normalized plan coordinates
    const planX = (canvasX - viewerState.offsetX) / (viewerState.planImage.width * viewerState.scale);
    const planY = (canvasY - viewerState.offsetY) / (viewerState.planImage.height * viewerState.scale);
    
    // Check if click is within plan bounds
    if (planX < 0 || planX > 1 || planY < 0 || planY > 1) return;
    
    const currentPlan = currentFloorPlanCard.plans[currentPlanIndex];
    const pin = await createPin(
      currentFloorPlanCard.reportId,
      currentFloorPlanCard.id,
      currentPlan.id,
      planX,
      planY
    );
    
    // Render pins immediately (synchronously) - don't await to prevent timing issues
    renderPins();
    
    // CLEAR STATE: Set up for card selection
    viewerState.isPlacingPin = true;
    viewerState.selectedUnlinkedPin = null; // Clear any previous selection
    viewerState.justPlacedPinId = pin.id; // Remember which pin we just placed
    
    // Keep pinpoint tool active for multiple pin placement
    // (Removed auto-switch to pan mode)
    
    // Update UI
    updateCardTrayHighlight();
    updateTrayHint();
    
    // Show popover for newly placed pin
    setTimeout(async () => {
      const pins = await loadPins();
      const placedPin = pins.find(p => p.id === pin.id);
      if (placedPin) {
        // Find the pin element to get its position
        const pinElement = document.querySelector(`g[data-pin-id="${pin.id}"]`);
        if (pinElement) {
          const pinRect = pinElement.getBoundingClientRect();
          const mockEvent = {
            target: pinElement,
            clientX: pinRect.left + pinRect.width / 2,
            clientY: pinRect.top + pinRect.height / 2
          };
          showPinPopover(placedPin, mockEvent);
        }
      }
    }, 100); // Small delay to ensure pin is rendered
  }
  
  // Touch event handlers (simplified)
  // Touch state for pinch-zoom and pan
  let touchState = {
    lastTouches: [],
    lastDistance: 0,
    initialScale: 1,
    initialPan: { x: 0, y: 0 }
  };

  function handleCanvasTouchStart(e) {
    console.log(`[iOS Debug] Touch start: ${e.touches.length} touches, tool: ${currentTool}`);
    touchState.lastTouches = Array.from(e.touches);
    
    if (e.touches.length === 1) {
      // Single touch - treat as mouse down for pin placement and panning
      const touch = e.touches[0];
      const canvas = e.target;
      const rect = canvas.getBoundingClientRect();
      
      console.log(`[iOS Debug] Touch coords - clientX: ${touch.clientX}, clientY: ${touch.clientY}, canvas rect: ${rect.left},${rect.top}`);
      
      const mouseEvent = new MouseEvent('mousedown', {
        clientX: touch.clientX,
        clientY: touch.clientY,
        button: 0,
        bubbles: true,
        cancelable: true
      });
      
      // Ensure the target is correct for coordinate calculations
      Object.defineProperty(mouseEvent, 'target', {
        value: canvas,
        enumerable: true
      });
      
      handleCanvasMouseDown(mouseEvent);
    } else if (e.touches.length === 2) {
      // Two finger touch - prepare for pinch zoom
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      touchState.lastDistance = getTouchDistance(touch1, touch2);
      touchState.initialScale = canvasScale;
      touchState.initialPan = { x: canvasPanX, y: canvasPanY };
      console.log(`[iOS Debug] Pinch start - distance: ${touchState.lastDistance}, scale: ${canvasScale}`);
    }
    e.preventDefault();
  }
  
  function handleCanvasTouchMove(e) {
    if (e.touches.length === 1) {
      // Single touch - panning or pin dragging
      const touch = e.touches[0];
      const canvas = e.target;
      
      const mouseEvent = new MouseEvent('mousemove', {
        clientX: touch.clientX,
        clientY: touch.clientY,
        button: 0,
        bubbles: true,
        cancelable: true
      });
      
      // Ensure the target is correct
      Object.defineProperty(mouseEvent, 'target', {
        value: canvas,
        enumerable: true
      });
      
      handleCanvasMouseMove(mouseEvent);
    } else if (e.touches.length === 2) {
      // Two finger pinch-zoom
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const currentDistance = getTouchDistance(touch1, touch2);
      
      if (touchState.lastDistance > 0) {
        const scaleChange = currentDistance / touchState.lastDistance;
        const newScale = Math.max(0.1, Math.min(5, canvasScale * scaleChange));
        
        console.log(`[iOS Debug] Pinch zoom - old scale: ${canvasScale.toFixed(2)}, new scale: ${newScale.toFixed(2)}, change: ${scaleChange.toFixed(2)}`);
        
        // Apply zoom
        canvasScale = newScale;
        drawFloorplanCanvas();
      }
      touchState.lastDistance = currentDistance;
    }
    touchState.lastTouches = Array.from(e.touches);
    e.preventDefault();
  }
  
  function handleCanvasTouchEnd(e) {
    console.log(`[iOS Debug] Touch end: ${e.touches.length} touches remaining`);
    
    if (e.touches.length === 0) {
      // All touches ended - trigger mouse up for pin placement
      const canvas = e.target;
      const lastTouch = touchState.lastTouches[0];
      
      if (lastTouch) {
        const mouseEvent = new MouseEvent('mouseup', {
          clientX: lastTouch.clientX,
          clientY: lastTouch.clientY,
          button: 0,
          bubbles: true,
          cancelable: true
        });
        
        // Ensure the target is correct
        Object.defineProperty(mouseEvent, 'target', {
          value: canvas,
          enumerable: true
        });
        
        console.log(`[iOS Debug] Triggering mouse up at: ${lastTouch.clientX}, ${lastTouch.clientY}`);
        handleCanvasMouseUp(mouseEvent);
      }
      
      touchState.lastTouches = [];
      touchState.lastDistance = 0;
    } else if (e.touches.length === 1) {
      // Went from 2 touches to 1 - end pinch zoom mode
      console.log(`[iOS Debug] Ending pinch zoom mode`);
      touchState.lastDistance = 0;
    }
    e.preventDefault();
  }
  
  // Helper function to calculate distance between two touches
  function getTouchDistance(touch1, touch2) {
    const dx = touch1.clientX - touch2.clientX;
    const dy = touch1.clientY - touch2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }
  
  function closeFloorPlanViewer() {
    const viewer = $('#floorplan-viewer');
    if (viewer) {
      viewer.setAttribute('hidden', '');
    }
    
    // Clear all tool button states
    const toolBtns = document.querySelectorAll('[data-floor-tool]');
    toolBtns.forEach(btn => {
      btn.classList.remove('active');
      // Remove event listeners to prevent memory leaks
      if (btn._toolClickHandler) {
        btn.removeEventListener('click', btn._toolClickHandler);
        btn._toolClickHandler = null;
      }
    });
    
    // Reset state
    currentFloorPlanCard = null;
    currentPlanIndex = 0;
    currentTool = 'pan';
    viewerState = {
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      isDragging: false,
      lastMouseX: 0,
      lastMouseY: 0,
      planImage: null,
      isPlacingPin: false,
      selectedUnlinkedPin: null,
      justPlacedPinId: null
    };
    
    // Clear global linking state
    isLinkingActive = false;
    
    hidePinPopover();
  }
  
  // Debouncing for renderCardTray to prevent excessive calls
  let renderCardTrayTimeout = null;
  const renderCardTrayDebounced = (delay = 100) => {
    if (renderCardTrayTimeout) {
      clearTimeout(renderCardTrayTimeout);
    }
    renderCardTrayTimeout = setTimeout(() => {
      renderCardTray();
    }, delay);
  };
  
  async function renderCardTray() {
    const trayContent = $('#floor-card-tray-content');
    if (!trayContent || !currentFloorPlanCard) return;
    
    // Get current report's cards from the existing library system
    const currentReportId = currentFloorPlanCard.reportId;
    
    // Load cards directly using Library API (no caching to avoid stale data)
    const cards = await window.Library.loadItems(currentReportId);
    
    trayContent.innerHTML = '';
    
    // Filter out note cards - only show image cards in floor plan viewer
    const imageCards = cards.filter(card => card.type !== 'note');
    
    if (imageCards.length === 0) {
      trayContent.innerHTML = '<div style="color:var(--muted);font-size:12px;text-align:center;padding:20px;">No image cards in current report</div>';
      return;
    }
    
    // Apply compact classes based on card count
    trayContent.className = 'floor-card-tray-content';
    if (imageCards.length === 3) {
      trayContent.className += ' compact-3';
    } else if (imageCards.length === 4) {
      trayContent.className += ' compact-4';
    } else if (imageCards.length >= 9) {
      trayContent.className += ' compact-9';
    }
    
    // Fixed positioning: Render all cards in original order, no separation by link status
    for (const card of imageCards) {
      const linkedPin = await getCardLinkedPin(card.id, currentReportId);
      // All cards are clickable and stay in same position regardless of link status
      const trayCard = createTrayCard(card, linkedPin, true);
      trayContent.appendChild(trayCard);
    }
  }
  
  function createTrayCard(card, linkedPin, isClickable) {
    const trayCard = document.createElement('div');
    trayCard.className = linkedPin ? 'tray-card has-pin-card' : 'tray-card';
    // Remove visual distinction for linked cards - they're now clickable for replacement
    trayCard.dataset.cardId = card.id;
    
    const cardType = card.type || 'image';
    const pinIndicatorHTML = linkedPin ? createPinIndicatorHTML(linkedPin) : '';
    
    trayCard.innerHTML = `
      <div class="tray-card-image${linkedPin ? ' has-pin' : ''}">
        ${cardType === 'image' ? `<img src="${card.url || card.baseUrl}" alt="Card">` : '📝'}
        ${pinIndicatorHTML}
      </div>
      <div class="tray-card-info">
        <div class="tray-card-meta">${linkedPin ? 'Linked' : 'Available'}</div>
      </div>
    `;
    
    if (isClickable) {
      trayCard.addEventListener('click', () => handleCardSelection(card.id));
    }
    
    return trayCard;
  }
  
  function createPinIndicatorHTML(pin) {
    return `
      <div class="pin-indicator">
        <svg width="38" height="46" viewBox="0 -4 38 50">
          <line x1="19" y1="37" x2="19" y2="8" stroke="#000" stroke-width="4.8" stroke-linecap="round"/>
          <circle cx="19" cy="8" r="12" fill="${pin.headColor}" stroke="#000" stroke-width="2.4"/>
        </svg>
      </div>
    `;
  }
  
  async function handleCardSelection(cardId) {
    
    let pinToLink = null;
    
    // Determine which pin to link - FIXED: Check selectedUnlinkedPin first (clicked pins)
    if (viewerState.selectedUnlinkedPin) {
      // Link the selected unlinked pin (clicked pin) - this is the main use case
      pinToLink = viewerState.selectedUnlinkedPin;
    } else if (viewerState.justPlacedPinId) {
      // Link the pin we just placed (immediate after placement)
      pinToLink = viewerState.justPlacedPinId;
    }
    
    if (!pinToLink) return;
    
    // Modern replacement logic: Check if card is already linked to any pin
    const existingPin = await getCardLinkedPin(cardId);
    if (existingPin && existingPin.id !== pinToLink) {
      // Unlink the card from its current pin first (replacement)
      await updatePin(existingPin.id, { linkedCardId: null });
    }
    
    // Link the pin to the selected card
    const result = await linkPinToCard(pinToLink, cardId);
    
    if (result) {
      // Update UI
      updateCardTrayHighlight();
      updateTrayHint();
      
      // Re-render pins to show updated link status (non-blocking)
      renderPins();
      
      // Keep pin selected for continued interaction (don't clear selection)
      // This allows for easy replacement workflow
      
      // Show updated popover for the newly linked pin
      const pins = await loadPins();
      const updatedPin = pins.find(p => p.id === pinToLink);
      if (updatedPin) {
        // Find the pin element to get its position
        const pinElement = document.querySelector(`g[data-pin-id="${pinToLink}"]`);
        if (pinElement) {
          const rect = pinElement.getBoundingClientRect();
          const repositionEvent = {
            target: pinElement,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2
          };
          showPinPopover(updatedPin, repositionEvent);
        }
      }
    }
  }
  
  // Modern Pin Popover System - Completely Rewritten
  async function showPinPopover(pin, event) {
    console.log('Show pin popover for:', pin.id);
    
    const popover = $('#pin-popover');
    if (!popover) return;
    
    // Get fresh pin data from memory cache for immediate responsiveness
    let pins;
    if (memoryPinsCache) {
      pins = memoryPinsCache;
    } else {
      pins = await loadPins();
    }
    const freshPin = pins.find(p => p.id === pin.id);
    if (!freshPin) {
      console.warn('Pin not found:', pin.id);
      return;
    }
    
    // Clear all previous popover content first
    clearPopoverContent();
    
    // Get fresh card information using proper Library API
    let cardInfo = null;
    if (freshPin.linkedCardId) {
      try {
        const currentReportId = currentFloorPlanCard?.reportId;
        if (currentReportId) {
          console.log('Loading cards for report:', currentReportId, 'to find linked card:', freshPin.linkedCardId);
          
          // Use Library.loadItems API (proper way to load cards from IndexedDB)
          if (window.Library && typeof window.Library.loadItems === 'function') {
            const cards = await window.Library.loadItems(currentReportId);
            cardInfo = cards.find(card => card.id === freshPin.linkedCardId);
            console.log('Fresh card info for pin', freshPin.id, ':', cardInfo ? `found ${cardInfo.name || cardInfo.filename}` : 'not found');
            
            if (cardInfo) {
              console.log('Card details:', {
                id: cardInfo.id,
                name: cardInfo.name,
                filename: cardInfo.filename,
                type: cardInfo.type,
                hasUrl: !!(cardInfo.url || cardInfo.baseUrl)
              });
            }
          } else {
            console.warn('Library.loadItems not available');
          }
        } else {
          console.warn('No current report ID available');
        }
      } catch (e) {
        console.warn('Could not load card info for pin:', freshPin.id, e);
      }
    }
    
    // Update popover with fresh data
    updatePopoverContent(freshPin, cardInfo);
    
    // Position popover - open to left if pin is near right edge to avoid card overlap
    const rect = event.target.getBoundingClientRect();
    const floorCanvas = document.getElementById('floor-canvas');
    const canvasRect = floorCanvas ? floorCanvas.getBoundingClientRect() : rect;
    
    // Calculate if pin is in the right portion (near card tray area)
    // Floor viewer layout is "1fr 240px" with 8px gap = cards start at ~75% of container width
    const rightThreshold = canvasRect.left + (canvasRect.width * 0.75);
    const openToLeft = rect.left > rightThreshold;
    
    if (openToLeft) {
      // Open to left - measure popover width first
      popover.style.visibility = 'hidden';
      popover.removeAttribute('hidden');
      const popoverWidth = popover.offsetWidth || 200; // fallback width
      popover.style.left = (rect.left - popoverWidth - 5) + 'px'; // Move 5px left of pin
      popover.style.visibility = 'visible';
    } else {
      // Open to right (original behavior)
      popover.style.left = (rect.left + 24.5) + 'px';
    }
    popover.style.top = (rect.top - 10) + 'px';
    
    // Show popover
    popover.removeAttribute('hidden');
    
    // Setup outside click handler
    setTimeout(() => {
      document.addEventListener('click', hidePopoverOnOutsideClick, true);
    }, 100);
  }
  
  function clearPopoverContent() {
    // Clear all content to prevent stale data
    const cardPreview = $('#pin-popover-card-preview');
    const cardImg = $('#pin-popover-card-img');
    const cardName = $('#pin-popover-card-name');
    const cardType = $('#pin-popover-card-type');
    const body = $('#pin-popover-body');
    const actions = $('#pin-popover-actions');
    
    if (cardPreview) cardPreview.hidden = true;
    if (cardImg) {
      cardImg.src = '';
      cardImg.style.display = 'none';
    }
    if (cardName) cardName.textContent = '';
    if (cardType) cardType.textContent = '';
    if (body) body.innerHTML = '';
    if (actions) actions.innerHTML = '';
  }
  
  function updatePopoverContent(pin, cardInfo) {
    const colorChip = $('#pin-color-chip');
    const title = $('#pin-popover-title');
    const body = $('#pin-popover-body');
    const actions = $('#pin-popover-actions');
    const cardPreview = $('#pin-popover-card-preview');
    const cardImg = $('#pin-popover-card-img');
    const cardName = $('#pin-popover-card-name');
    const cardType = $('#pin-popover-card-type');
    
    // Debug: Check if popover elements exist
    if (!cardPreview || !cardImg || !cardName || !cardType) {
      console.error('Missing pin popover elements:', {
        cardPreview: !!cardPreview,
        cardImg: !!cardImg,
        cardName: !!cardName,
        cardType: !!cardType
      });
    }
    
    // Set pin color
    if (colorChip) colorChip.style.backgroundColor = pin.headColor;
    
    // Set title
    if (title) {
      title.textContent = cardInfo ? 'Linked to Card' : 'Unlinked Pin';
    }
    
    // Handle card preview
    console.log('Updating popover content. CardInfo:', cardInfo ? 'present' : 'null', 'Elements found:', {
      cardPreview: !!cardPreview,
      cardImg: !!cardImg, 
      cardName: !!cardName,
      cardType: !!cardType
    });
    
    if (cardInfo && cardPreview && cardImg && cardName && cardType) {
      console.log('Showing card in popover:', cardInfo.name || cardInfo.filename);
      cardPreview.hidden = false;
      if (cardInfo.url || cardInfo.baseUrl) {
        cardImg.src = cardInfo.url || cardInfo.baseUrl;
        cardImg.style.display = 'block';
      } else {
        cardImg.style.display = 'none';
      }
      cardName.textContent = cardInfo.name || cardInfo.filename || 'Unnamed Card';
      cardType.textContent = `${cardInfo.type || 'image'} card`;
    } else if (cardPreview) {
      console.log('Hiding card preview in popover');
      cardPreview.hidden = true;
    } else if (cardInfo) {
      // Fallback: Show card info in body if preview elements missing
      console.log('Using fallback card display in body');
      if (body) {
        body.innerHTML = `<div style="padding: 8px; background: #f0f9ff; border-radius: 4px; margin-bottom: 8px;">
          <strong>Linked Card:</strong> ${cardInfo.name || cardInfo.filename || 'Unnamed Card'}<br>
          <small>Type: ${cardInfo.type || 'image'} card</small>
        </div>` + (body.innerHTML || '');
      }
    }
    
    // Set pin details
    if (body) {
      const positionInches = normalizedToInches(pin.x, pin.y);
      const details = `
        <div><strong>Pin Details:</strong></div>
        <div>Pin Color: ${pin.headColor}</div>
        <div>Created: ${new Date(pin.createdAt).toLocaleDateString()}</div>
        <div>Position: ${positionInches.x}" x ${positionInches.y}" from top-left</div>
        ${!cardInfo ? '<div style="color:var(--muted); margin-top:4px;">No card linked</div>' : ''}
      `;
      body.innerHTML = details;
    }
    
    // Set actions
    if (actions) {
      actions.innerHTML = `
        <button class="btn pin-unlink-btn">Unlink</button>
        <button class="btn btn-red pin-delete-btn">Delete</button>
      `;
      
      // Add fresh event listeners
      const unlinkBtn = actions.querySelector('.pin-unlink-btn');
      const deleteBtn = actions.querySelector('.pin-delete-btn');
      
      if (unlinkBtn) {
        unlinkBtn.addEventListener('click', async (event) => {
          await unlinkPin(pin.id);
          
          // Set pin as selected for immediate re-linking
          viewerState.selectedUnlinkedPin = pin.id;
          viewerState.isPlacingPin = false;
          viewerState.justPlacedPinId = null;
          
          // Re-render UI elements and WAIT for card tray to complete before highlighting
          renderPins(); // Non-blocking for pins
          await renderCardTray(); // MUST wait for card tray before highlighting
          
          // Update UI to show red highlighting and proper hint AFTER card tray is rendered
          updateCardTrayHighlight();
          updateTrayHint();
          
          // Refresh popover with updated data at same position
          const pins = await loadPins();
          const updatedPin = pins.find(p => p.id === pin.id);
          if (updatedPin) {
            // Find the pin element to get its position
            const pinElement = document.querySelector(`g[data-pin-id="${pin.id}"]`);
            if (pinElement) {
              const rect = pinElement.getBoundingClientRect();
              const repositionEvent = {
                target: pinElement,
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2
              };
              showPinPopover(updatedPin, repositionEvent);
            }
          }
        });
      }
      
      if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
          await deletePin(pin.id);
          hidePinPopover(true); // Close popover since pin is deleted
          renderPins(); // Non-blocking for better responsiveness
          renderCardTray(); // Non-blocking for better responsiveness
        });
      }
    }
  }
  
  function hidePopoverOnOutsideClick(event) {
    const popover = $('#pin-popover');
    const cardTray = $('#floor-card-tray-content');
    const floorCanvas = $('#floor-canvas');
    
    // Check if click is outside popover AND not on a card or canvas (preserve popover for pin placements)
    if (popover && !popover.contains(event.target)) {
      const isCardClick = cardTray && cardTray.contains(event.target);
      const isCanvasClick = floorCanvas && floorCanvas.contains(event.target);
      
      // Don't hide popover for card clicks or canvas pin placements
      if (!isCardClick && !isCanvasClick) {
        hidePinPopover(true); // Clear selection for true outside clicks
        document.removeEventListener('click', hidePopoverOnOutsideClick, true);
      }
    }
  }
  
  function hidePinPopover(clearSelection = false) {
    const popover = $('#pin-popover');
    if (popover) {
      popover.setAttribute('hidden', '');
    }
    
    // Clear all popover content to prevent stale data
    clearPopoverContent();
    
    // Only clear pin selection if explicitly requested (user cancelled)
    if (clearSelection) {
      clearPinSelection();
      updateCardTrayHighlight();
      updateTrayHint();
    }
  }
  
  // Test if a blob URL is accessible
  async function testBlobUrlAccessible(blobUrl) {
    try {
      // For images, we can test by loading in an Image object
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = blobUrl;
        // Timeout after 1 second
        setTimeout(() => resolve(false), 1000);
      });
    } catch (error) {
      return false;
    }
  }

  // Restore blob URLs for existing plans (for session persistence)
  async function restoreBlobUrls() {
    try {
      const floorPlans = await loadFloorPlans();
      let hasUpdates = false;
      let restoredCount = 0;
      let fallbackCount = 0;
      
      console.log(`Checking ${floorPlans.length} floor plans for blob URL restoration...`);
      
      for (const floorPlan of floorPlans) {
        if (floorPlan.plans) {
          for (const plan of floorPlan.plans) {
            // Check if plan has data and needs blob URL restoration
            const hasOriginalData = plan.originalSrc && plan.originalSrc.length > 0;
            const hasSrcData = plan.src && plan.src.length > 0;
            
            if (!hasOriginalData && !hasSrcData) {
              console.warn('Plan has no image data:', plan.id);
              continue;
            }
            
            // Check if plan needs blob URL restoration (test accessibility if it exists)
            let needsRestoration = hasOriginalData && !plan.blobUrl;
            
            if (hasOriginalData && plan.blobUrl && plan.blobUrl.startsWith('blob:')) {
              // Test if existing blob URL is accessible
              const isAccessible = await testBlobUrlAccessible(plan.blobUrl);
              if (isAccessible) {
                console.log('Floor plan blob URL is still valid:', plan.id);
                needsRestoration = false;
              } else {
                console.log('Floor plan blob URL is invalid, needs restoration:', plan.id);
                needsRestoration = true;
              }
            } else if (hasOriginalData) {
              needsRestoration = true;
            }
            
            if (needsRestoration) {
              console.log('Restoring blob URL for plan:', plan.id);
              
              // Try to restore from originalSrc first
              if (plan.originalSrc) {
                const blobData = createBlobUrl(plan.originalSrc);
                if (blobData) {
                  plan.blobUrl = blobData.blobUrl;
                  plan.blobId = blobData.blobId;
                  hasUpdates = true;
                  restoredCount++;
                  console.log('Successfully restored blob URL for plan:', plan.id);
                } else {
                  console.warn('Failed to create blob URL, using fallback for plan:', plan.id);
                  // Fallback: use originalSrc directly if blob creation fails
                  if (plan.originalSrc.startsWith('data:')) {
                    plan.blobUrl = plan.originalSrc;
                    fallbackCount++;
                    hasUpdates = true;
                  }
                }
              } else if (plan.src && plan.src.startsWith('data:')) {
                // Fallback to src field if originalSrc is missing
                console.log('Using src as fallback for plan:', plan.id);
                plan.blobUrl = plan.src;
                fallbackCount++;
                hasUpdates = true;
              }
            }
          }
        }
      }
      
      // Save updates if any blob URLs were regenerated
      if (hasUpdates) {
        console.log(`Restored ${restoredCount} blob URLs and ${fallbackCount} fallbacks, saving to IndexedDB`);
        await saveFloorPlans(floorPlans);
      } else {
        console.log('No blob URLs needed restoration');
      }
    } catch (error) {
      console.error('Error during blob URL restoration:', error);
    }
  }
  
  // Initialize Floor Plan System
  async function initFloorPlans() {
    console.log('Initializing Floor Plan System...');
    
    // Set up PDF.js worker
    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
    }
    
    // Set up pin popover close button
    const pinPopoverClose = $('#pin-popover-close');
    if (pinPopoverClose) {
      pinPopoverClose.addEventListener('click', () => {
        hidePinPopover(true); // Close popover and clear selection
      });
    }
    
    // Don't restore blob URLs during initialization - wait for report ID to be available
    
    // File upload handling
    const fileInput = $('#floorplan-file-input');
    if (fileInput) {
      on(fileInput, 'change', async function(e) {
        const files = e.target.files;
        if (files.length > 0) {
          for (const file of files) {
            if (file.type === 'application/pdf') {
              await processPDF(file);
            } else {
              alert('Please select PDF files only.');
            }
          }
          // Reset input
          fileInput.value = '';
        }
      });
    }
    
    // Initial render
    renderFloorPlanCards();
  }
  
  // Global exports for integration with existing system
  window.FloorPlans = {
    init: initFloorPlans,
    createFloorPlanCard,
    deleteFloorPlanCard,
    createPin,
    deletePin,
    linkPinToCard,
    unlinkPin,
    getCardLinkedPin,
    handleCardDeletion,
    handleJobDeletion,
    get isUploadingFloorPlan() { return isUploadingFloorPlan; },
    renderFloorPlanCards,
    loadFloorPlans,
    loadPins,
    restoreBlobUrls,
    getBlobUrl,
    isLinkingActive: () => isLinkingActive
  };
  
  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFloorPlans);
  } else {
    initFloorPlans();
  }
  
})();