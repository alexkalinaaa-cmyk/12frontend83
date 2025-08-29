(function(){
  "use strict";
  const $ = sel => document.querySelector(sel);
  const on = (el, ev, fn, opts) => { if(el) el.addEventListener(ev, fn, opts||false); };

  const UI = {
    btnFloorplans: $("#btn-floorplans"), // Changed from btn-library
    btnCreate: $("#job-create"),
    btnClearData: $("#clear-all-data"), // Changed to new bottom-right button
    unifiedList: $("#unified-list"),
    bucket: $("#board"), // Changed from cards-bucket to board
    pdfBucket: $("#pdf-bucket"),
    btnExport: $("#lib-export")
  };

  const K_IDS="JL_report_ids_v1", K_CUR="JL_current_report_id_v2", K_ITEM="JL_items_by_report_v1";
  const K_NAMES="JL_report_names_v1", K_NMAP="JL_reportname_to_reportids_v1";
  const K_PDF="JL_pdf_reports_v1";
  const K_JOBCODE="JL_jobcode_";
  const K_LOCATION="JL_location_";

  // Global PDF generation lock
  let isGeneratingPDF = false;
  
  

  // Enhanced reverse geocoding with multiple service fallbacks
  async function reverseGeocodeEnhanced(lat, lng) {
    const services = [
      // Primary: OpenStreetMap Nominatim with higher zoom for better precision
      async () => {
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1&zoom=18`, {
          headers: {
            'User-Agent': 'JL-Field-Reports-App/1.0'
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          if (data && data.display_name) {
            const address = data.address;
            if (address) {
              const addressParts = [];
              const locationParts = [];
              
              // Build street address part with more detail
              if (address.house_number && address.road) {
                addressParts.push(`${address.house_number} ${address.road}`);
              } else if (address.road) {
                addressParts.push(address.road);
              } else if (address.commercial || address.building || address.amenity) {
                addressParts.push(address.commercial || address.building || address.amenity);
              }
              
              // Build location part (City, State ZIP)
              const city = address.city || address.town || address.village || address.municipality;
              if (city) locationParts.push(city);
              if (address.state) locationParts.push(address.state);
              
              // Add ZIP code if available
              if (address.postcode) {
                if (locationParts.length > 0) {
                  locationParts[locationParts.length - 1] += ` ${address.postcode}`;
                } else {
                  locationParts.push(address.postcode);
                }
              }
              
              // Combine parts
              const fullAddress = [];
              if (addressParts.length > 0) fullAddress.push(addressParts.join(' '));
              if (locationParts.length > 0) fullAddress.push(locationParts.join(', '));
              
              if (fullAddress.length > 0) {
                return fullAddress.join(', ');
              }
            }
            return data.display_name;
          }
        }
        throw new Error('Nominatim failed');
      },
      
      // Fallback: BigDataCloud (free tier, often more accurate for US addresses)
      async () => {
        const response = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`);
        
        if (response.ok) {
          const data = await response.json();
          if (data && data.locality) {
            const parts = [];
            if (data.streetNumber && data.streetName) {
              parts.push(`${data.streetNumber} ${data.streetName}`);
            } else if (data.streetName) {
              parts.push(data.streetName);
            }
            if (data.city) parts.push(data.city);
            if (data.principalSubdivision) parts.push(data.principalSubdivision);
            if (data.postcode) parts.push(data.postcode);
            
            if (parts.length > 0) {
              return parts.join(', ');
            }
          }
        }
        throw new Error('BigDataCloud failed');
      }
    ];
    
    // Try each service in order
    for (let i = 0; i < services.length; i++) {
      try {
        const result = await services[i]();
        if (result && result !== `${lat}, ${lng}`) {
          console.log(`Geocoding successful with service ${i + 1}: ${result}`);
          return result;
        }
      } catch (error) {
        console.log(`Geocoding service ${i + 1} failed:`, error.message);
        if (i === services.length - 1) {
          // Last service failed, return coordinates
          throw error;
        }
      }
    }
    
    // Return coordinates as ultimate fallback
    return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  }

  // Keep the original function for backward compatibility
  async function reverseGeocode(lat, lng) {
    try {
      return await reverseGeocodeEnhanced(lat, lng);
    } catch (error) {
      console.warn('All reverse geocoding services failed:', error);
      return `${lat}, ${lng}`;
    }
  }

  // API Configuration - Direct connection to Render backend
  const RENDER_BACKEND_URL = 'https://g-j-l7j-al-f-y64lp-on-g2jl6j9-0l0l-j-l-j.onrender.com';

  // High-precision geolocation function
  async function getPrecisePosition({ desiredAccuracy = 50, hardTimeoutMs = 15000 } = {}) {
    if (!('geolocation' in navigator)) throw new Error('Geolocation not supported');

    // Ask for permission status so we can guide the user if denied
    try {
      const perm = await navigator.permissions.query({ name: 'geolocation' });
      if (perm.state === 'denied') {
        throw new Error('Location permission denied');
      }
    } catch { /* older browsers */ }

    return new Promise((resolve, reject) => {
      const opts = { enableHighAccuracy: true, maximumAge: 0, timeout: hardTimeoutMs };
      let best = null;
      let watchId = null;
      const done = (result, err) => {
        if (watchId != null) navigator.geolocation.clearWatch(watchId);
        err ? reject(err) : resolve(result);
      };

      // Keep improving as the radio locks in (GPS/Wi-Fi)
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
          // Stop early once we're precise enough
          if (pos.coords.accuracy <= desiredAccuracy) done(pos);
        },
        (err) => done(null, err),
        opts
      );

      // Safety stop in case we never get "good enough"
      setTimeout(() => best ? done(best) : done(null, new Error('Timed out')), hardTimeoutMs + 1000);
    });
  }
  
  // Load API configuration from Render backend
  async function loadAPIConfig() {
    try {
      const response = await fetch(`${RENDER_BACKEND_URL}/api/config`);
      if (response.ok) {
        const config = await response.json();
        window.API_KEY = config.apiKey;
        console.log('[Config] API key loaded from Render backend');
      } else {
        console.warn('[Config] Failed to load API config from Render backend');
        // Fallback API key if config fails
        window.API_KEY = '417739249b8bccdce71c7099eff84f29';
      }
    } catch (error) {
      console.warn('[Config] Error loading API config from Render backend:', error);
      // Fallback API key if config fails
      window.API_KEY = '417739249b8bccdce71c7099eff84f29';
    }
  }

  // Initialize config when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadAPIConfig);
  } else {
    loadAPIConfig();
  }

  // Extract all asset files (images and notes) from report items
  async function extractAssetFiles(reportId) {
    const assetFiles = [];
    let generalNoteCounter = 0;
    let itemCounter = 0; // Separate counter for actual items (non-notes)
    
    try {
      // Load all items for this report
      const allItems = await loadItems(reportId);
      console.log(`[Assets] Loaded ${allItems.length} total items for report ${reportId}`);
      console.log(`[Assets] Items data:`, allItems.map(item => ({id: item.id, type: item.type, hasDataUrl: !!item.dataUrl, hasText: !!item.text})));
      
      // Include all items (images and general notes) for SharePoint assets
      const orderedItems = allItems;
      
      console.log(`[Assets] Processing ${orderedItems.length} items for asset extraction (filtered from ${allItems.length} total)`);
      
      // Process each item for images and notes
      for (let i = 0; i < orderedItems.length; i++) {
        const item = orderedItems[i];
        // Only increment item counter for non-note items
        const itemNumber = item.type === "note" ? null : ++itemCounter;
        
        console.log(`[Assets] Processing ${item.type === "note" ? "note card" : `item ${itemNumber}`} (chronological position ${i + 1}):`, item.id);
        console.log(`[Assets] Item structure:`, JSON.stringify(item, null, 2));
        console.log(`[Assets] Item properties:`, Object.keys(item));
        console.log(`[Assets] Item dataUrl:`, !!item.dataUrl, typeof item.dataUrl);
        console.log(`[Assets] Item src:`, !!item.src, typeof item.src);
        console.log(`[Assets] Item text:`, !!item.text, typeof item.text);
        
        // Skip image processing for note cards
        if (item.type !== "note") {
          // Extract main annotation image (converted to PNG) - check multiple possible properties
          const imageData = item.dataUrl || item.src || item.url || item.imageData || item.base64;
          console.log(`[Assets] Image data found:`, !!imageData, imageData ? `type: ${typeof imageData}, length: ${imageData.length}, starts with: ${imageData.substring(0, 50)}` : 'none');
          
          if (imageData && imageData.startsWith('data:image/')) {
            assetFiles.push({
              fileName: `${itemNumber}Item.png`,
              fileData: imageData,
              type: 'image'
            });
            console.log(`[Assets] Added main image: ${itemNumber}Item.png`);
          } else if (imageData) {
            console.log(`[Assets] Image data exists but doesn't start with 'data:image/':`, imageData.substring(0, 100));
          } else {
            console.log(`[Assets] No image data found for item ${itemNumber}`);
          }
        }
        
          // Extract pin area image if exists (already PNG from generatePinAreaImageAsync)
          if (window.FloorPlans && item.type !== "note") {
            const linkedPin = await window.FloorPlans.getCardLinkedPin(item.id);
            if (linkedPin) {
              const floorPlan = await getFloorPlanForPin(linkedPin);
              if (floorPlan && floorPlan.src) {
                try {
                  const pinImageData = await generatePinAreaImageAsync(linkedPin, floorPlan);
                  if (pinImageData) {
                    assetFiles.push({
                      fileName: `${itemNumber}ItemPin.png`,
                      fileData: pinImageData,
                      type: 'pin-image'
                    });
                    console.log(`[Assets] Added pin image: ${itemNumber}ItemPin.png`);
                  }
                } catch (error) {
                  console.warn(`[Assets] Failed to generate pin image for item ${itemNumber}:`, error);
                }
              }
            }
          }
        
          // Extract item notes - only for items with images, not pure note cards
          if (item.type !== "note") {
            const textData = item.text || item.content || item.notes || item.description;
            console.log(`[Assets] Text data found:`, !!textData, textData ? `type: ${typeof textData}, length: ${textData.length}` : 'none');
            
            if (textData && textData.trim()) {
              assetFiles.push({
                fileName: `${itemNumber}ItemNotes.txt`,
                fileData: textData.trim(),
                type: 'text'
              });
              console.log(`[Assets] Added notes: ${itemNumber}ItemNotes.txt`);
            } else {
              console.log(`[Assets] No text data found for item ${itemNumber}`);
            }
          } else {
            console.log(`[Assets] Skipping ItemNotes extraction for note card - will be handled as general note`);
          }
        }
      
      // Extract general notes (note cards)
      const noteCards = allItems.filter(item => item.type === "note");
      console.log(`[Assets] Found ${noteCards.length} note cards for general notes`);
      
      for (const noteCard of noteCards) {
        const noteText = noteCard.text || noteCard.content || noteCard.notes || noteCard.description;
        console.log(`[Assets] Note card text found:`, !!noteText, noteText ? `length: ${noteText.length}` : 'none');
        
        if (noteText && noteText.trim()) {
          const letter = String.fromCharCode(65 + generalNoteCounter); // A, B, C, etc.
          assetFiles.push({
            fileName: `${letter}GeneralNotes.txt`,
            fileData: noteText.trim(),
            type: 'general-note'
          });
          console.log(`[Assets] Added general notes: ${letter}GeneralNotes.txt`);
          generalNoteCounter++;
        }
      }
      
      console.log(`[Assets] Total assets extracted: ${assetFiles.length} files`);
      return assetFiles;
      
    } catch (error) {
      console.error('[Assets] Error extracting asset files:', error);
      return []; // Return empty array on error to allow PDF upload to continue
    }
  }

  // Simple SharePoint upload functionality
  async function uploadToSharePoint(pdf) {
    console.log('[SharePoint] Starting upload process for PDF:', pdf.filename);
    console.log('[SharePoint] PDF object contents:', {
      filename: pdf.filename,
      hasDataUrl: !!pdf.dataUrl,
      hasBlobUrl: !!pdf.blobUrl,
      dataUrlLength: pdf.dataUrl ? pdf.dataUrl.length : 0,
      blobUrlLength: pdf.blobUrl ? pdf.blobUrl.length : 0,
      size: pdf.size,
      pageCount: pdf.pageCount,
      fullObject: pdf
    });
    
    const btn = document.querySelector('#pdf-sharepoint');
    if (btn) {
      btn.textContent = 'Uploading...';
      btn.disabled = true;
    }

    try {
      // Basic validation
      if (!pdf.dataUrl && !pdf.blobUrl) {
        throw new Error('No PDF data available for upload');
      }

      // Use dataUrl or convert blobUrl to dataUrl
      let fileData = pdf.dataUrl;
      
      if (!fileData && pdf.blobUrl) {
        try {
          console.log('[SharePoint] No dataUrl, trying to fetch from blobUrl:', pdf.blobUrl);
          // Convert blob URL to data URL if needed
          const response = await fetch(pdf.blobUrl);
          if (!response.ok) {
            throw new Error(`Blob fetch failed: ${response.status}`);
          }
          const blob = await response.blob();
          console.log('[SharePoint] PDF blob size:', blob.size, 'bytes');
          
          if (blob.size === 0) {
            throw new Error('Blob is empty');
          }
          
          fileData = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('FileReader failed'));
            reader.readAsDataURL(blob);
          });
        } catch (error) {
          console.error('[SharePoint] Blob URL fetch failed:', error);
          throw new Error(`Cannot access PDF data: ${error.message}. The PDF may have been generated in a previous session.`);
        }
      }

      if (!fileData) {
        throw new Error('No PDF data available for upload - both dataUrl and blobUrl are missing');
      }
      
      console.log('[SharePoint] PDF data length:', fileData.length, 'characters');
      console.log('[SharePoint] PDF data preview:', fileData.substring(0, 100));
      
      // Detect and convert different PDF data formats
      let finalFileData = fileData;
      
      if (fileData.startsWith('data:application/pdf')) {
        console.log('[SharePoint] PDF data is in PDF data URL format');
        // Handle data URLs with or without filename parameter
        // e.g., data:application/pdf;base64,... or data:application/pdf;filename=...;base64,...
        const base64Part = fileData.split(',')[1];
        if (!base64Part || base64Part.length < 100) {
          console.error('[SharePoint] Base64 data too small:', base64Part?.length || 0, 'characters');
          throw new Error('PDF data appears to be corrupted - base64 content is too small');
        }
        console.log('[SharePoint] PDF base64 data size:', base64Part.length, 'characters');
      } else if (fileData.startsWith('blob:')) {
        console.log('[SharePoint] PDF data is blob URL, already handled above');
        throw new Error('Blob URL should have been converted to data URL above');
      } else if (fileData.startsWith('data:')) {
        console.log('[SharePoint] Data URL is not PDF format:', fileData.substring(0, 50));
        throw new Error('Data URL is not in PDF format');
      } else {
        console.error('[SharePoint] Unknown PDF data format:', fileData.substring(0, 50));
        throw new Error(`Unknown PDF data format. Expected data URL or blob URL, got: ${fileData.substring(0, 50)}`);
      }

      // Collect required metadata from existing form fields
      const author = document.getElementById('set-name')?.value || 'Unknown Author';
      
      // Get job name from PDF metadata (stored during generation)
      let jobName = pdf.jobName || 'Unknown Job';
      
      console.log('[SharePoint] Job name from PDF metadata:', jobName);
      
      const reportId = (window.library && window.library.getCurrentReportId ? window.library.getCurrentReportId() : null) || `RPT-${Date.now()}`;
      const jobCode = document.getElementById('job-code')?.value || document.getElementById('job-code-input')?.value || null;
      
      console.log('[SharePoint] Collected metadata:', { author, jobName, reportId, jobCode });
      
      // Build comprehensive metadata object
      const jobFolder = jobCode ? `${jobCode}-${jobName}` : jobName;
      
      const metadata = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        reportId,
        author,
        jobName,
        jobCode: jobCode || null,
        pdf: { 
          fileName: pdf.filename, 
          sizeBytes: pdf.size || null, 
          pageCount: pdf.pageCount || null 
        },
        job: { 
          id: window.currentJobId || null, 
          locationId: null, 
          locationName: null 
        },
        app: { 
          name: "JL Annotator", 
          version: window.JL_APP_VERSION || null, 
          environment: window.location?.hostname || null 
        },
        floorplans: [],
        modals: {},
        notes: "",
        sharepointTarget: {
          site: "johnsonlancasterassoc.sharepoint.com:/sites/JL_FIELD_REPORTS",
          library: "REPORT FILES",
          path: [author, jobFolder, reportId, "assets"].join("/")
        }
      };

      console.log('[SharePoint] Uploading to folder structure:', `${author}/${jobFolder}/${reportId}`);

      // Extract all asset files (images and notes) from the report items
      console.log('[SharePoint] Extracting asset files from report items...');
      const assetFiles = await extractAssetFiles(reportId);
      console.log(`[SharePoint] Extracted ${assetFiles.length} asset files:`, assetFiles.map(f => f.fileName));

      // Make the upload request to Render backend
      const response = await fetch(`${RENDER_BACKEND_URL}/api/upload-to-sharepoint`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': window.API_KEY || '417739249b8bccdce71c7099eff84f29'
        },
        body: JSON.stringify({
          fileName: pdf.filename,
          fileData: finalFileData,
          author,
          jobName,
          reportId,
          jobCode,
          metadata,
          assetFiles
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || `Upload failed: ${response.statusText}`);
      }

      const result = await response.json();
      
      // Show success message with asset count
      const assetCount = assetFiles.length;
      const assetMessage = assetCount > 0 ? `\n\nAssets: ${assetCount} files uploaded (images and notes)` : '';
      alert(`✅ Successfully uploaded to SharePoint!\n\nFile: ${result.fileName}\nPath: ${result.reportPath || 'SharePoint'}\nURL: ${result.pdfWebUrl || 'SharePoint'}${assetMessage}\n\nYour PDF, metadata, and all assets have been uploaded to the structured folder system.`);
      
      console.log('[SharePoint] Upload completed successfully:', result);
      
      // Trigger Power Automate flow after successful SharePoint upload
      await triggerPowerAutomateFlow(result, metadata, jobName);
      
    } catch (error) {
      console.error('[SharePoint] Upload failed:', error);
      
      let errorMessage = 'Failed to upload to SharePoint:\n';
      if (error.message.includes('SharePoint not configured')) {
        errorMessage += 'SharePoint is not configured on the server. Please contact your administrator.';
      } else if (error.message.includes('network') || error.message.includes('fetch')) {
        errorMessage += 'Network error. Please check your connection and try again.';
      } else {
        errorMessage += error.message;
      }
      
      alert(errorMessage);
    } finally {
      if (btn) {
        btn.textContent = 'Send to SharePoint';
        btn.disabled = false;
      }
    }
  }

  // Power Automate flow trigger
  async function triggerPowerAutomateFlow(sharePointResult, metadata, jobName) {
    try {
      console.log('[Power Automate] Triggering flow after SharePoint success');
      
      // Get current date in YYYY-MM-DD format
      const reportDate = new Date().toISOString().slice(0, 10);
      
      // Get location from the field
      const locationField = document.getElementById('location-field');
      const gpsLocation = locationField ? locationField.value || 'Not specified' : 'Not specified';
      
      // Build comprehensive notes summary with proper formatting
      let notesSummary = 'No notes available';
      try {
        const reportId = metadata.reportId;
        const allItems = await loadItems(reportId);
        
        let notesParts = [];
        
        // Add general notes first (at top)
        const generalNotes = allItems.filter(item => item.type === "note");
        if (generalNotes.length > 0) {
          let generalNotesText = "GENERAL NOTES:\n";
          generalNotes.forEach((note, index) => {
            const letter = String.fromCharCode(65 + index); // A, B, C...
            const content = note.content || note.text || 'No content';
            generalNotesText += `${letter}. ${content.trim()}\n`;
          });
          notesParts.push(generalNotesText.trim());
        }
        
        // Add item notes following underneath
        const imageItems = allItems.filter(item => item.type !== "note" && (item.text || item.content || item.notes || item.description));
        if (imageItems.length > 0) {
          let itemNotesText = "ITEM NOTES:\n";
          imageItems.forEach((item, index) => {
            const itemNum = index + 1;
            const content = item.text || item.content || item.notes || item.description;
            if (content && content.trim()) {
              itemNotesText += `Item ${itemNum}: ${content.trim()}\n`;
            }
          });
          if (itemNotesText !== "ITEM NOTES:\n") {
            notesParts.push(itemNotesText.trim());
          }
        }
        
        if (notesParts.length > 0) {
          notesSummary = notesParts.join('\n\n');
        }
      } catch (error) {
        console.warn('[Power Automate] Could not build notes summary:', error);
      }
      
      // Check for floor plans
      let hasFloorPlans = 'No';
      try {
        if (window.FloorPlans && window.FloorPlans.loadFloorPlans) {
          const reportId = metadata.reportId;
          const floorPlans = await window.FloorPlans.loadFloorPlans();
          const reportFloorPlans = floorPlans.filter(fp => fp.reportId === reportId);
          hasFloorPlans = (reportFloorPlans && reportFloorPlans.length > 0) ? 'Yes' : 'No';
          console.log(`[Power Automate] Floor plans check: Found ${reportFloorPlans.length} floor plans for report ${reportId}`);
        }
      } catch (error) {
        console.warn('[Power Automate] Could not check floor plans:', error);
        hasFloorPlans = 'No';
      }
      
      // Use SharePoint-provided assets URLs (no more hardcoded %20 encoding issues)
      const assetsPath = sharePointResult.reportPath ? 
        `${sharePointResult.reportPath}/assets` : 'Assets path not available';
      const assetsUrl = sharePointResult.assetsUrl || 'Assets URL not available';
      
      // Build the payload for Power Automate (matching HTTP trigger schema exactly)
      const powerAutomatePayload = {
        reportId: metadata.reportId,
        reportName: jobName,
        fileName: sharePointResult.fileName || 'PDF file name not available',
        fileUrl: sharePointResult.pdfWebUrl || 'PDF URL not available', // ← This is your PDF URL!
        author: metadata.author,
        jobName: jobName,
        jobCode: metadata.jobCode || '',
        reportPath: sharePointResult.reportPath || 'Report path not available',
        assetsPath: assetsPath,
        assetsUrl: assetsUrl,
        timestamp: new Date().toISOString(),
        location: gpsLocation,
        floorPlan: hasFloorPlans,
        notesSummary: notesSummary
      };
      
      console.log('[Power Automate] Payload:', powerAutomatePayload);
      
      // Send HTTP POST request to Power Automate flow
      const powerAutomateUrl = 'https://default3610ebdb35ef4ec0a712ae12b33ec9.b9.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/eeb866f20db64178900a4b7ed46bd5ee/triggers/manual/paths/invoke/?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=J1J4ADvqJ3diaEs99ipDQIIFE4e5g_Mo0rz1kijbXVY';
      
      const response = await fetch(powerAutomateUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(powerAutomatePayload)
      });
      
      if (response.ok) {
        console.log('[Power Automate] Flow triggered successfully');
      } else {
        console.warn('[Power Automate] Flow trigger failed:', response.status, response.statusText);
      }
      
    } catch (error) {
      console.error('[Power Automate] Error triggering flow:', error);
      // Don't throw error - we don't want to break SharePoint success flow
    }
  }

  // Storage management constants - IndexedDB has much higher limits
  const STORAGE_LIMIT_MB = 200; // IndexedDB can handle much larger datasets
  const CLEANUP_THRESHOLD_MB = 80; // Start cleanup when approaching limit
  const BYTES_PER_MB = 1024 * 1024;

  // Storage monitoring functions - only count meaningful app data
  async function getStorageSize() {
    let totalSize = 0;
    
    try {
      // Count localStorage data first (immediate and reliable)
      for (const key in localStorage) {
        if (localStorage.hasOwnProperty(key) && key.startsWith("JL_")) {
          const value = localStorage.getItem(key);
          if (value && value.length > 2) { // Ignore empty/trivial entries
            totalSize += value.length;
          }
        }
      }
      
      // Add IndexedDB data if available (for data moved out of localStorage)
      if (window.IndexedStorage && window.IndexedStorage.Storage) {
        try {
          const indexedSize = await window.IndexedStorage.Storage.getSize();
          // Only add IndexedDB size for data that's NOT in localStorage
          // This prevents double-counting during migration
          totalSize += Math.max(0, indexedSize - totalSize);
        } catch (error) {
          console.warn('IndexedDB size calculation failed:', error);
        }
      }
    } catch (error) {
      console.warn('Storage size calculation error:', error);
    }
    
    return totalSize;
  }

  async function getStorageSizeMB() {
    const size = await getStorageSize();
    return size / BYTES_PER_MB;
  }

  // Storage diagnostic function - shows exactly what's taking up space
  function getStorageDiagnostic() {
    const diagnostic = [];
    let totalSize = 0;
    
    for (const key in localStorage) {
      if (localStorage.hasOwnProperty(key) && key.startsWith("JL_")) {
        const value = localStorage.getItem(key);
        if (value) {
          const sizeMB = (value.length / BYTES_PER_MB).toFixed(2);
          totalSize += value.length;
          diagnostic.push({
            key: key,
            sizeMB: sizeMB,
            sizeBytes: value.length,
            isCorrupted: value.length > 500000 && (value.length < 1000 || !value.startsWith('[') && !value.startsWith('{') && !value.startsWith('"'))
          });
        }
      }
    }
    
    // Sort by size (largest first)
    diagnostic.sort((a, b) => b.sizeBytes - a.sizeBytes);
    
    return {
      items: diagnostic,
      totalSizeMB: (totalSize / BYTES_PER_MB).toFixed(2),
      totalSizeBytes: totalSize,
      corruptedCount: diagnostic.filter(item => item.isCorrupted).length
    };
  }

  async function isStorageNearLimit() {
    const sizeMB = await getStorageSizeMB();
    return sizeMB > CLEANUP_THRESHOLD_MB;
  }

  // Clear all app data - removes all JL_ prefixed keys from localStorage and IndexedDB
  async function clearAllAppData() {
    const diagnostic = getStorageDiagnostic();
    console.log('Clearing all app data. Current state:', diagnostic);
    
    let clearedCount = 0;
    
    // Clear localStorage
    const keysToRemove = [];
    for (const key in localStorage) {
      if (localStorage.hasOwnProperty(key) && key.startsWith("JL_")) {
        keysToRemove.push(key);
      }
    }
    
    keysToRemove.forEach(key => {
      try {
        localStorage.removeItem(key);
        clearedCount++;
      } catch (error) {
        console.warn(`Failed to remove localStorage key ${key}:`, error);
      }
    });
    
    // Clear IndexedDB if available
    if (window.IndexedStorage && window.IndexedStorage.Storage) {
      try {
        await window.IndexedStorage.Storage.clear();
        console.log('IndexedDB cleared successfully');
      } catch (error) {
        console.warn('Failed to clear IndexedDB:', error);
      }
    }
    
    console.log(`Cleared ${clearedCount} localStorage keys`);
    return {
      clearedLocalStorage: clearedCount,
      previousSize: diagnostic.totalSizeMB,
      corruptedItemsRemoved: diagnostic.corruptedCount
    };
  }

  async function cleanupOldestItems() {
    const allJobIds = await loadIds();
    const itemsByAge = [];
    
    // Collect all items with timestamps
    for (const reportId of allJobIds) {
      const items = await loadItems(reportId);
      items.forEach(item => {
        itemsByAge.push({
          type: 'item',
          reportId,
          item,
          timestamp: item.timestamp || 0
        });
      });
    }

    // Also collect floor plan data for cross-system cleanup
    if (window.FloorPlans && window.FloorPlans.loadFloorPlans) {
      const floorPlans = window.FloorPlans.loadFloorPlans();
      floorPlans.forEach(floorPlan => {
        // Add floor plan card itself
        itemsByAge.push({
          type: 'floorplan',
          floorPlan,
          timestamp: floorPlan.createdAt || 0
        });
        
        // Add individual plans within floor plan card
        if (floorPlan.plans) {
          floorPlan.plans.forEach(plan => {
            itemsByAge.push({
              type: 'plan',
              floorPlanId: floorPlan.id,
              plan,
              timestamp: floorPlan.createdAt || 0 // Use floor plan creation time
            });
          });
        }
      });
    }

    // Sort by age (oldest first)
    itemsByAge.sort((a, b) => a.timestamp - b.timestamp);

    // Remove oldest items until under threshold
    let removedCount = 0;
    while (isStorageNearLimit() && itemsByAge.length > 0) {
      const oldest = itemsByAge.shift();
      
      if (oldest.type === 'item') {
        await removeItem(oldest.reportId, oldest.item.id);
        removedCount++;
      } else if (oldest.type === 'floorplan' && window.FloorPlans && window.FloorPlans.deleteFloorPlanCard) {
        window.FloorPlans.deleteFloorPlanCard(oldest.floorPlan.id);
        removedCount++;
        console.log(`Cleaned up floor plan: ${oldest.floorPlan.filename}`);
      }
      // Skip individual plans - they get cleaned up when the floor plan card is deleted
    }

    if (removedCount > 0) {
      console.log(`Storage cleanup: removed ${removedCount} old items/floor plans`);
    }

    return removedCount;
  }

  // Pure async read function - uses IndexedDB exclusively
  const read = async (k, d) => {
    try {
      // All app data goes through IndexedDB
      if (window.IndexedStorage && window.IndexedStorage.Storage) {
        const result = await window.IndexedStorage.Storage.getItem(k);
        if (result && result !== "null" && result !== "undefined") {
          return JSON.parse(result);
        }
      }
      
      return d;
    } catch (e) {
      console.error(`Failed to read ${k} from IndexedDB:`, e);
      return d;
    }
  };
  
  // Async read function for IndexedDB operations
  const readAsync = async (k, d) => {
    try {
      const result = await window.IndexedStorage.Storage.getItem(k);
      return result ? JSON.parse(result) : d;
    } catch (_) {
      return d;
    }
  };
  // Pure async write function - uses IndexedDB exclusively
  const write = async (k, v) => {
    try {
      const dataString = JSON.stringify(v);
      const dataSizeMB = dataString.length / BYTES_PER_MB;
      
      // All app data goes to IndexedDB
      if (window.IndexedStorage && window.IndexedStorage.Storage) {
        await window.IndexedStorage.Storage.setItem(k, dataString);
        console.log(`Saved ${k} to IndexedDB (${dataSizeMB.toFixed(1)}MB)`);
        return;
      }
      
      // IndexedDB should always be available in production
      console.error(`IndexedDB not available for ${k} - cannot save data`);
      throw new Error(`IndexedDB not available. Cannot save ${k} (${dataSizeMB.toFixed(1)}MB).`);
      
    } catch (e) {
      console.error(`Failed to save ${k}:`, e);
      throw e;
    }
  };
  
  // Async write function for IndexedDB operations
  const writeAsync = async (k, v) => {
    try {
      const dataString = JSON.stringify(v);
      await window.IndexedStorage.Storage.setItem(k, dataString);
      console.log(`Saved ${k} to IndexedDB (${(dataString.length/1024/1024).toFixed(1)}MB)`);
    } catch (e) {
      console.error(`Failed to save ${k} to IndexedDB:`, e);
      throw e;
    }
  };
  const itemsKey=jid=>K_ITEM+(jid||"");
  const nameKey=nid=>K_NMAP+":"+(nid||"");
  const loadNames = async () => await read(K_NAMES, []);
  const saveNames = async (a) => await write(K_NAMES, a || []);
  const loadNameMap = async (nid) => await read(nameKey(nid), []);
  const saveNameMap = async (nid, a) => await write(nameKey(nid), a || []);
  const loadIds = async () => await read(K_IDS, []);
  const saveIds = async (a) => await write(K_IDS, a || []);
  // Current report ID functions - IndexedDB only  
  let currentReportIdCache = null;
  
  // Initialize cache on startup
  const initCurrentReportIdCache = async () => {
    try {
      const result = await window.IndexedStorage.Storage.getItem(K_CUR);
      currentReportIdCache = result ? JSON.parse(result) : "";
    } catch (_) {
      currentReportIdCache = "";
    }
  };
  
  const getCur = () => {
    // Return cached value for synchronous access
    return currentReportIdCache || "";
  };
  
  const getCurAsync = async () => {
    try {
      // Use cache if available
      if (currentReportIdCache !== null) {
        return currentReportIdCache;
      }
      
      const result = await window.IndexedStorage.Storage.getItem(K_CUR);
      currentReportIdCache = result ? JSON.parse(result) : "";
      return currentReportIdCache;
    } catch (_) {
      return "";
    }
  };
  
  const setCur = async (id) => {
    try {
      const value = id || "";
      currentReportIdCache = value; // Update cache immediately
      await window.IndexedStorage.Storage.setItem(K_CUR, JSON.stringify(value));
    } catch (_) {
      console.warn("Failed to set current report ID");
    }
  };
  
  const loadItems = async (jid) => await read(itemsKey(jid), []);
  const saveItems = async (jid, a) => await write(itemsKey(jid), a || []);
  const loadPDFs = async () => await read(K_PDF, []);
  const savePDFs = async (a) => await write(K_PDF, a || []);
  const loadJobCode = async (jid) => await read(K_JOBCODE + jid + "_v1", "");
  const saveJobCode = async (jid, code) => await write(K_JOBCODE + jid + "_v1", code || "");
  const loadLocation = async (jid) => {
    try {
      // First try to get the raw value to check if it's corrupted
      const locationKey = K_LOCATION + jid + "_v1";
      if (window.IndexedStorage && window.IndexedStorage.Storage) {
        const rawResult = await window.IndexedStorage.Storage.getItem(locationKey);
        
        // If the raw result looks like plain text (not JSON), use it directly
        if (rawResult && typeof rawResult === 'string' && !rawResult.startsWith('"') && !rawResult.startsWith('{')) {
          console.log('Found plain text location data, using directly:', rawResult);
          // Re-save it properly as JSON
          await saveLocation(jid, rawResult);
          return rawResult;
        }
      }
      
      // Otherwise use normal read process
      const result = await read(locationKey, "");
      return typeof result === 'string' ? result : "";
    } catch (error) {
      console.warn('Error loading location for', jid, ':', error);
      // If there's a parse error, try to clear the corrupted data
      if (error.message.includes('Unexpected token')) {
        console.log('Clearing corrupted location data for', jid);
        await saveLocation(jid, "");
      }
      return "";
    }
  };
  const saveLocation = async (jid, location) => {
    try {
      const locationString = (location || "").toString().trim();
      await write(K_LOCATION + jid + "_v1", locationString);
    } catch (error) {
      console.warn('Error saving location for', jid, ':', error);
    }
  };

  function generateJobId(){
    try{
      // Generate 3 random letters A-Z
      const letterArray = new Uint8Array(3);
      crypto.getRandomValues(letterArray);
      const letters = Array.from(letterArray, byte => 
        String.fromCharCode(65 + (byte % 26))).join('');
      
      // Generate 6-digit number (100000-999999)
      const numberArray = new Uint8Array(4);
      crypto.getRandomValues(numberArray);
      const randomValue = (numberArray[0] << 24) | (numberArray[1] << 16) | (numberArray[2] << 8) | numberArray[3];
      const number = String(100000 + (Math.abs(randomValue) % 900000)).padStart(6, '0');
      
      return `${letters}-${number}`;
    } catch(e) {
      // Fallback for older browsers
      const letters = Array.from({length: 3}, () => 
        String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
      const number = String(100000 + Math.floor(Math.random() * 900000));
      return `${letters}-${number}`;
    }
  }

  // Unified system - label is same as Report ID
  function generateLabel(){
    return generateJobId();
  }

  async function ensureCur(autoCreate = true){
    let id = await getCurAsync();
    if(!id && autoCreate){
      // Use new paired creation logic - create both job name and report ID
      const reportId = generateJobId();
      const nameId = "N" + generateJobId().slice(0, 8);
      const jobLabel = "New Report Name";
      
      // Create the job name
      const names = await loadNames();
      names.push({id: nameId, label: jobLabel, createdAt: Date.now()});
      await saveNames(names);
      
      // Create the report ID  
      const ids = await loadIds();
      ids.push({id: reportId, label: reportId, createdAt: Date.now()});
      await saveIds(ids);
      
      // Attach the report ID to the job name (create the pair)
      await attachJobToName(nameId, reportId);
      
      // Set as current and initialize
      setCur(reportId);
      await saveItems(reportId, []);
      
      // Update UI to show the newly created report
      await renderUnifiedList();
      await renderCards();
      
      // Ensure UI controls update after library state is fully committed
      if(window.updateUIControlsState) {
        console.log('About to call updateUIControlsState, current report ID:', getCur());
        // Call immediately - setCur is synchronous and should be complete
        await window.updateUIControlsState();
      }
      
      id = reportId;
    }
    return id;
  }

  async function attachJobToName(nid,jid){ 
    if(!nid||!jid) return; 
    await detachJobFromAll(jid); // Ensure job only belongs to one name
    const a = await loadNameMap(nid); 
    if(a.indexOf(jid)===-1){ a.push(jid); await saveNameMap(nid,a);} 
  }

  async function detachJobFromAll(jid){ 
    const ns = await loadNames(); 
    for (const n of ns) {
      const a = await loadNameMap(n.id); 
      const k = a.indexOf(jid); 
      if(k>=0){ a.splice(k,1); await saveNameMap(n.id,a);} 
    }
  }

  async function renderUnifiedList(){
    if(!UI.unifiedList) return;
    const names = await loadNames();
    const ids = await loadIds();
    const cur = getCur();
    
    UI.unifiedList.innerHTML = "";

    // Render Report Names with attached Report IDs
    for (let i = 0; i < names.length; i++) {
      const nameEntry = names[i];
      const nameDiv = document.createElement("div");
      nameDiv.className = "report-name-item";
      nameDiv.dataset.nameId = nameEntry.id;

      // Report Name container with button and delete
      const nameContainer = document.createElement("div");
      nameContainer.style.cssText = "display:flex;gap:4px;align-items:center;";
      
      const nameBtn = document.createElement("button");
      nameBtn.className = "report-name-btn";
      nameBtn.textContent = nameEntry.label || "Unnamed Job";
      nameBtn.draggable = false;


      // Inline rename on click
      nameBtn.addEventListener("click", function(){
        startInlineRename(nameBtn, nameEntry.id);
      });


      nameContainer.appendChild(nameBtn);
      nameDiv.appendChild(nameContainer);

      // Child Jobs container
      const childJobs = document.createElement("div");
      childJobs.className = "child-reports";
      
      const attachedJobs = await loadNameMap(nameEntry.id) || [];
      attachedJobs.forEach(function(jid){
        const jobData = ids.find(x => x.id === jid);
        if(!jobData) return;

        const childBtn = document.createElement("button");
        childBtn.className = "child-report-btn" + (jid === cur ? " current" : "");
        childBtn.textContent = jobData.label || jobData.id;
        childBtn.title = jobData.id;
        childBtn.dataset.reportId = jid;

        // Report ID click to select
        childBtn.addEventListener("click", async function(){
          setCur(jid);
          if(window.AppBoard && AppBoard.clearAndRenderFrom) await AppBoard.clearAndRenderFrom(jid);
          await renderUnifiedList(); 
          await renderCards();
          await renderPDFCards();
          if(window.updateUIControlsState) await window.updateUIControlsState();
          
          // Load Job Code for this Report ID
          const jobCodeInput = document.getElementById('job-code');
          if (jobCodeInput) {
            jobCodeInput.value = await loadJobCode(jid);
          }
          
          // Load Location for this Report ID
          const locationInput = document.getElementById('location-field');
          if (locationInput) {
            const savedLocation = await loadLocation(jid);
            console.log('Loading location for report', jid, ':', savedLocation);
            locationInput.value = savedLocation;
          }
          
          // Re-render floor plan cards when switching Report IDs
          if (window.FloorPlans && window.FloorPlans.renderFloorPlanCards) {
            await window.FloorPlans.renderFloorPlanCards();
          }
        });

        // Delete Report ID button
        const deleteJobBtn = document.createElement("button");
        deleteJobBtn.className = "btn btn-small";
        deleteJobBtn.textContent = "×";
        deleteJobBtn.title = "Delete Report ID and all its data";
        deleteJobBtn.style.cssText = "min-width:24px;min-height:24px;padding:2px;background:#7f1d1d;color:white;border:none;margin-left:4px;font-size:14px;";
        deleteJobBtn.addEventListener("click", async function(e){
          e.stopPropagation();
          await deleteReportAndJobName(jid);
        });

        // Drop target for cards with swap animation
        childBtn.addEventListener("dragover", function(e){
          e.preventDefault();
          childBtn.classList.add("drop-target");
          childBtn.classList.add("swap-target"); // Add red arrows overlay
        });
        childBtn.addEventListener("dragleave", function(e){
          childBtn.classList.remove("drop-target");
          childBtn.classList.remove("swap-target"); // Remove red arrows overlay
        });
        childBtn.addEventListener("drop", async function(e){
          e.preventDefault();
          e.stopPropagation(); // Prevent bubbling
          childBtn.classList.remove("drop-target");
          childBtn.classList.remove("swap-target"); // Remove red arrows overlay
          
          const cid = e.dataTransfer.getData("text/plain");
          const sourceJid = e.dataTransfer.getData("text/sourceJid");
          // Only move if we have valid data and it's actually a different destination
          if(cid && sourceJid && jid !== sourceJid) {
            await moveCardTo(jid, cid, sourceJid);
          }
        });

        // Container for Report ID button and delete button
        const childContainer = document.createElement("div");
        childContainer.style.cssText = "display:flex;align-items:center;margin-bottom:2px;";
        childBtn.style.flex = "1";
        
        childContainer.appendChild(childBtn);
        childContainer.appendChild(deleteJobBtn);
        childJobs.appendChild(childContainer);
      });

      nameDiv.appendChild(childJobs);
      UI.unifiedList.appendChild(nameDiv);
      
      // Add separator line except after the last item
      if (i < names.length - 1) {
        const separator = document.createElement("div");
        separator.style.cssText = "height: 3px; background: #444444; margin: 16px 0; opacity: 0.8; border-radius: 2px;";
        UI.unifiedList.appendChild(separator);
      }
    }

    // Note: Unattached Report IDs section removed - all Report IDs are now created with job names
  }

  function startInlineRename(btn, nameId){
    const originalText = btn.textContent;
    
    const input = document.createElement("input");
    input.className = "report-name-input";
    input.value = originalText;
    input.style.width = btn.offsetWidth + "px";
    
    btn.style.display = "none";
    btn.parentElement.insertBefore(input, btn);
    
    input.focus();
    input.select();

    let inputElement = input;
    let isFinishing = false;
    
    async function finishEdit(){
      if (!inputElement || isFinishing) return;
      isFinishing = true;

      const newValue = inputElement.value.trim() || originalText;
      const names = await loadNames();
      const nameIndex = names.findIndex(n => n.id === nameId);
      if(nameIndex >= 0){
        names[nameIndex].label = newValue;
        await saveNames(names);
      }
      
      // Remove input element safely
      if(inputElement && inputElement.parentElement) {
        inputElement.parentElement.removeChild(inputElement);
      }
      
      btn.style.display = "";
      btn.textContent = newValue;
      inputElement = null;
    }

    input.addEventListener("blur", () => finishEdit());
    input.addEventListener("keydown", function(e){
      if(e.key === "Enter"){
        e.preventDefault();
        finishEdit().catch(console.error);
      }
      if(e.key === "Escape"){
        e.preventDefault();
        if(inputElement && inputElement.parentElement && !isFinishing) {
          isFinishing = true;
          inputElement.parentElement.removeChild(inputElement);
          btn.style.display = "";
          inputElement = null;
        }
      }
    });
  }

  // Clean up any stale drag state
  function cleanupDragState() {
    document.querySelectorAll("#board .placeholder, #board .dragging").forEach(el => {
      el.classList.remove("placeholder", "dragging");
    });
  }

  // Modern workspace drag with position-aware reordering
  function addWorkspaceDragToTile(tile){
    // Always reset drag functionality to prevent stale state
    tile.__dragEnabled = false;
    
    // Ensure clean state
    cleanupDragState();
    
    // Prevent drag when floor plan linking is active
    if(window.FloorPlans && window.FloorPlans.isLinkingActive && window.FloorPlans.isLinkingActive()) {
      return;
    }
    
    if(tile.__dragEnabled) return;
    tile.__dragEnabled = true;
    
    tile.draggable = true;
    
    // Drag start
    tile.addEventListener("dragstart", function(e){
      if(window.__libOpen) {
        e.preventDefault();
        return;
      }
      
      const cardId = tile.getAttribute("data-card-id");
      const currentJid = window.Library && Library.getCur ? Library.getCur() : "";
      
      e.dataTransfer.setData("text/plain", cardId);
      e.dataTransfer.setData("text/sourceJid", currentJid);
      e.dataTransfer.setData("text/workspaceDrag", "true");
      e.dataTransfer.effectAllowed = "move";
      
      tile.classList.add("dragging");
    });

    // Drag end
    tile.addEventListener("dragend", function(e){
      tile.classList.remove("dragging");
      // Clean up all drag-related classes from workspace
      document.querySelectorAll("#board .placeholder").forEach(el => el.classList.remove("placeholder"));
    });

    // Simple dragover for position swapping
    tile.addEventListener("dragover", function(e){
      if(window.__libOpen) return;
      
      const isWorkspaceDrag = e.dataTransfer.types.includes("text/workspaceDrag") || 
                              e.dataTransfer.types.includes("text/plain");
      if(!isWorkspaceDrag) return;
      
      e.preventDefault();
      
      // Clean previous drag classes from all workspace tiles
      document.querySelectorAll("#board .placeholder, #board .swap-target").forEach(el => {
        el.classList.remove("placeholder");
        el.classList.remove("swap-target");
      });
      
      // Add placeholder styling and swap arrows to current tile
      tile.classList.add("placeholder");
      tile.classList.add("swap-target");
    });

    tile.addEventListener("dragleave", function(e){
      tile.classList.remove("placeholder");
      tile.classList.remove("swap-target");
    });

    tile.addEventListener("drop", function(e){
      if(window.__libOpen) return;
      
      e.preventDefault();
      e.stopPropagation();
      tile.classList.remove("placeholder");
      tile.classList.remove("swap-target");
      
      const draggedCardId = e.dataTransfer.getData("text/plain");
      const isWorkspaceDrag = e.dataTransfer.getData("text/workspaceDrag");
      const targetCardId = tile.getAttribute("data-card-id");
      
      if(isWorkspaceDrag && draggedCardId && targetCardId && draggedCardId !== targetCardId) {
        const currentJid = window.Library && Library.getCur ? Library.getCur() : "";
        swapCardsInWorkspace(currentJid, draggedCardId, targetCardId);
      }
    });

    // Click to open editor
    tile.addEventListener("click", function(e){
      if(window.__libOpen) return;
      if(e.target.tagName === "BUTTON") return;
      
      if(window.openEditor) {
        window.openEditor(tile);
      }
    });
  }

  // Library card rendering and atomic moves

  function generateLibraryLetter(index) {
    if (index < 26) {
      return String.fromCharCode(65 + index); // A, B, C...
    } else {
      const firstLetter = Math.floor((index - 26) / 26);
      const secondLetter = (index - 26) % 26;
      return String.fromCharCode(65 + firstLetter) + String.fromCharCode(65 + secondLetter); // AA, AB...
    }
  }
  
  // Storage indicator update function - handles both sync and async calls
  function updateStorageIndicator() {
    const storageText = document.getElementById('storage-text');
    const storageFill = document.getElementById('storage-fill');
    
    if (!storageText || !storageFill) return;
    
    // Set default values first to prevent UI issues
    storageText.textContent = 'Storage: ...MB';
    storageFill.style.width = '0%';
    storageFill.className = 'storage-fill';
    
    // Try to get size asynchronously
    getStorageSizeMB().then(currentSizeMB => {
      const percentage = Math.min(100, (currentSizeMB / STORAGE_LIMIT_MB) * 100);
      
      storageText.textContent = `Storage: ${currentSizeMB.toFixed(1)}MB`;
      storageFill.style.width = `${percentage}%`;
      
      // Update color based on usage
      storageFill.className = 'storage-fill';
      if (percentage > 87.5) { // 7MB+
        storageFill.className += ' critical';
      } else if (percentage > 75) { // 6MB+
        storageFill.className += ' warning';
      }
    }).catch(error => {
      console.warn('Failed to update storage indicator:', error);
      storageText.textContent = 'Storage: --MB';
      storageFill.style.width = '0%';
    });
  }

  // Function to open editor from library card click
  function openEditorFromCard(cardElement, item) {
    // Create a temporary tile element that matches the workspace card structure
    const tempTile = document.createElement("div");
    tempTile.className = "tile card";
    tempTile.setAttribute("data-card-id", item.id);
    tempTile.style.display = "none"; // Hide it since we only need it for the API
    
    if(item.type === "note") {
      // Create note tile structure
      tempTile.classList.add("note-tile");
      const noteIcon = document.createElement("div");
      noteIcon.className = "note-icon";
      noteIcon.textContent = "📝";
      const label = document.createElement("div");
      label.className = "note-label";
      tempTile.appendChild(noteIcon);
      tempTile.appendChild(label);
    } else {
      // Create image tile structure
      const img = document.createElement("img");
      img.src = item.composedUrl || item.baseUrl || item.url || "";
      img.alt = item.name || "";
      tempTile.appendChild(img);
    }
    
    // Temporarily add to document so openEditor can find it
    document.body.appendChild(tempTile);
    
    // Open the editor using the existing openEditor function from app.js
    if(window.openEditor) {
      window.openEditor(tempTile);
    }
    
    // Clean up the temporary element after a short delay
    setTimeout(() => {
      if (tempTile.parentNode) {
        tempTile.parentNode.removeChild(tempTile);
      }
    }, 100);
  }

  let isRenderingCards = false;
  
  async function renderCards(){
    if(!UI.bucket || isRenderingCards) return;
    isRenderingCards = true;
    
    try {
      const jid = getCur(); 
      
      if(!jid){ 
        UI.bucket.innerHTML = "<div style='opacity:.7'>No Report ID selected.</div>"; 
        updateStorageIndicator();
        return; 
      }
      
      // Build new content in document fragment to prevent flash
      const fragment = document.createDocumentFragment();
      
      const items = await loadItems(jid);
      
      if (items.length === 0) {
        const emptyDiv = document.createElement("div");
        emptyDiv.style.opacity = "0.7";
        emptyDiv.textContent = "No cards in this report.";
        fragment.appendChild(emptyDiv);
      }
      
      items.forEach(function(it, i){
      const d = document.createElement("div");
      d.className = "thumb"; 
      // Prevent drag when floor plan linking is active
      d.draggable = !(window.FloorPlans && window.FloorPlans.isLinkingActive && window.FloorPlans.isLinkingActive());
      d.dataset.cardId = it.id;

      // Add dragstart listener
      d.addEventListener("dragstart", function(e){
        e.dataTransfer.setData("text/plain", it.id); // Card ID
        e.dataTransfer.setData("text/sourceJid", jid); // Source Report ID
        e.dataTransfer.effectAllowed = "move";
      });

      // Add dragend listener to handle UI cleanup
      d.addEventListener("dragend", function(e){
        // Remove dragging class without full re-render to avoid image flicker
        d.classList.remove("dragging");
        // Clear any remaining drag state classes
        document.querySelectorAll(".thumb.dragging, .thumb.drop-target, .thumb.swap-target").forEach(el => {
          el.classList.remove("dragging", "drop-target", "swap-target");
        });
      });

      // Add card-to-card reordering functionality with swap arrows
      d.addEventListener("dragover", function(e){
        e.preventDefault();
        
        // Clean previous drag targets
        document.querySelectorAll("#cards-bucket .placeholder, #cards-bucket .swap-target").forEach(el => {
          el.classList.remove("placeholder", "swap-target");
        });
        
        // Add swap-target styling with red arrows
        d.classList.add("swap-target");
      });

      d.addEventListener("dragleave", function(e){
        d.classList.remove("placeholder", "swap-target");
      });

      d.addEventListener("drop", function(e){
        e.preventDefault();
        e.stopPropagation();
        d.classList.remove("placeholder");
        
        const draggedCardId = e.dataTransfer.getData("text/plain");
        const sourceJid = e.dataTransfer.getData("text/sourceJid");
        
        // Only handle reordering within same Report ID
        if(draggedCardId && sourceJid === jid && draggedCardId !== it.id) {
          swapCardsInLibrary(jid, draggedCardId, it.id);
        }
      });
      
      if(it.type === "note") {
        // Create note thumbnail with consistent structure
        const noteContent = document.createElement("div");
        noteContent.className = "note-thumb-content";
        
        const noteIcon = document.createElement("div");
        noteIcon.className = "note-thumb-icon";
        noteIcon.style.cssText = "display:flex;align-items:center;justify-content:center;font-size:32px;background:#E6F0FF;border:2px solid #B2CCFF;color:#666;";
        noteIcon.textContent = "📝";
        
        const noteLabel = document.createElement("div");
        noteLabel.className = "note-thumb-label";
        noteLabel.style.cssText = "padding:2px;font-size:10px;font-weight:600;text-align:center;background:#333;color:#fff;";
        
        // Calculate letter for note
        const noteItems = items.filter(item => item.type === "note");
        const noteIndex = noteItems.findIndex(item => item.id === it.id);
        const letter = generateLibraryLetter(noteIndex);
        
        let labelText = `General Notes ${letter}.`;
        if(it.name && it.name.trim()) {
          const name = it.name.trim();
          // Truncate if too long (max ~15 chars for name part)
          const truncatedName = name.length > 15 ? name.substring(0,12) + "..." : name;
          labelText = `General Notes ${letter}. ${truncatedName}`;
        }
        noteLabel.textContent = labelText;
        
        noteContent.appendChild(noteIcon);
        noteContent.appendChild(noteLabel);
        d.appendChild(noteContent);
      } else {
        // Create image thumbnail (original logic)
        const img = document.createElement("img"); 
        img.src = (it.composedUrl||it.baseUrl||it.url||""); 
        img.alt = it.name||("Card "+(i+1));
        d.appendChild(img);
      }
      
      // Add delete button (red X) 
      const del = document.createElement("button");
      del.className = "card-delete";
      del.textContent = "×";
      del.addEventListener("click", async function(e) {
        e.stopPropagation();
        if(!jid) return;
        
        // Create meaningful confirmation message based on card type
        let confirmMessage;
        if(it.type === "note") {
          const noteItems = items.filter(item => item.type === "note");
          const noteIndex = noteItems.findIndex(item => item.id === it.id);
          const letter = generateLibraryLetter(noteIndex);
          if(it.name && it.name.trim()) {
            confirmMessage = `Delete General Notes ${letter}. "${it.name.trim()}"?\n\nThis action cannot be undone.`;
          } else {
            confirmMessage = `Delete General Notes ${letter}?\n\nThis action cannot be undone.`;
          }
        } else {
          const cardName = it.name || `Card ${items.indexOf(it) + 1}`;
          confirmMessage = `Delete "${cardName}"?\n\nThis action cannot be undone.`;
        }
        
        // Show confirmation dialog
        if(confirm(confirmMessage)) {
          await removeItem(jid, it.id);
          if(window.renderCards) renderCards();
        }
      });
      d.appendChild(del);
      
      // Add click-to-open functionality
      d.addEventListener("click", function(e) {
        // Don't open if clicking delete button or if dragging
        if (e.target.classList.contains('card-delete')) return;
        if (d.classList.contains('dragging')) return;
        
        // Find or create the tile element in the workspace and open editor
        openEditorFromCard(d, it);
      });
      
      fragment.appendChild(d); // Add to fragment instead of directly to UI.bucket
    });
    
      // Replace all content at once to prevent flash
      UI.bucket.innerHTML = "";
      UI.bucket.appendChild(fragment);
      
      // Update storage indicator after rendering cards
      updateStorageIndicator();
    } catch (error) {
      console.error('Error rendering cards:', error);
      UI.bucket.innerHTML = "<div style='opacity:.7;color:#e74c3c'>Error loading cards. Please refresh.</div>";
    } finally {
      isRenderingCards = false;
    }
  }

  // Simple position swapping for library cards
  async function swapCardsInLibrary(jid, draggedCardId, targetCardId) {
    try {
      const items = await loadItems(jid);
      const draggedIndex = items.findIndex(x => x.id === draggedCardId);
      const targetIndex = items.findIndex(x => x.id === targetCardId);
      
      if(draggedIndex >= 0 && targetIndex >= 0 && draggedIndex !== targetIndex) {
        // Simple array swap
        [items[draggedIndex], items[targetIndex]] = [items[targetIndex], items[draggedIndex]];
        
        // Save and refresh
        await saveItems(jid, items);
        renderCards(); // Don't await to avoid blocking drag
        if(window.AppBoard) await AppBoard.clearAndRenderFrom(jid);
      }
    } catch (error) {
      console.error('Error swapping cards:', error);
    }
  }

  // Simple position swapping for workspace cards
  async function swapCardsInWorkspace(jid, draggedCardId, targetCardId) {
    try {
      const items = await loadItems(jid);
    const draggedIndex = items.findIndex(x => x.id === draggedCardId);
    const targetIndex = items.findIndex(x => x.id === targetCardId);
    
      if(draggedIndex >= 0 && targetIndex >= 0 && draggedIndex !== targetIndex) {
        // Simple array swap
        [items[draggedIndex], items[targetIndex]] = [items[targetIndex], items[draggedIndex]];
        
        // Save and refresh
        await saveItems(jid, items);
        if(window.AppBoard) await AppBoard.clearAndRenderFrom(jid);
        renderCards(); // Don't await to avoid blocking
      }
    } catch (error) {
      console.error('Error swapping workspace cards:', error);
    }
  }

  async function moveCardTo(toJid, cardId, sourceJid){
    if(!cardId || !toJid || toJid === sourceJid) return;
    
    // Trust the provided sourceJid (from drag system)
    if(!sourceJid) {
      console.warn('moveCardTo: no sourceJid provided');
      return;
    }
    
    try {
      // Get card data from specific source
      const sourceItems = await loadItems(sourceJid);
      const foundIndex = sourceItems.findIndex(x => x.id === cardId);
      
      if(foundIndex >= 0) {
        // Preserve ALL annotation data during move
        const cardData = sourceItems[foundIndex]; // includes composedUrl, inkUrl, texts, notes
        
        // Atomic remove from source
        sourceItems.splice(foundIndex, 1);
        await saveItems(sourceJid, sourceItems);
        
        // Atomic add to destination
        cardData.reportId = toJid;
        const destItems = await loadItems(toJid);
        destItems.push(cardData);
        await saveItems(toJid, destItems);
        
        const currentJob = getCur();
        
        // Immediately clear workspace if we moved from current report to prevent phantom cards
        if(sourceJid === currentJob && window.AppBoard) {
          const board = document.getElementById("board");
          if(board) board.innerHTML = "";
        }
        
        // Refresh UI after storage operations complete
        renderUnifiedList(); // Fire-and-forget for drag operations
        renderCards(); // Don't await to avoid blocking
        if(window.AppBoard) {
          await AppBoard.clearAndRenderFrom(currentJob);
        }
      }
    } catch (error) {
      console.error('Error moving card:', error);
    }
  }

  async function findJobNameForJobId(jid) {
    const names = await loadNames();
    for(const nameEntry of names) {
      const attachedJobs = await loadNameMap(nameEntry.id) || [];
      if(attachedJobs.includes(jid)) {
        return nameEntry;
      }
    }
    return null;
  }

  function generateReportId() {
    const numbers = Math.floor(Math.random() * 1000000000).toString().padStart(9, '0');
    const letters = Array.from({length: 3}, () => 
      String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
    return `${numbers}-${letters}`;
  }

  function showError(message) {
    // Simple error display - could be enhanced with modal later
    alert(message);
  }

  // Validate required fields for export
  async function validateRequiredForExport(jid) {
    const missingFields = [];

    // Check global settings (Name and Email)
    try {
      if (window.IndexedStorage && window.IndexedStorage.Storage) {
        const settings = await window.IndexedStorage.Storage.getItem("JL_settings_v2");
        if (settings) {
          const settingsData = JSON.parse(settings);
          if (!settingsData.name || !settingsData.name.trim()) {
            missingFields.push("Name (in Settings)");
          }
          if (!settingsData.mail || !settingsData.mail.trim()) {
            missingFields.push("Email (in Settings)");
          }
        } else {
          missingFields.push("Name (in Settings)", "Email (in Settings)");
        }
      } else {
        missingFields.push("Name (in Settings)", "Email (in Settings)");
      }
    } catch (error) {
      console.warn('Error checking settings:', error);
      missingFields.push("Name (in Settings)", "Email (in Settings)");
    }

    // Check per-report location
    try {
      const location = await loadLocation(jid);
      if (!location || !location.trim()) {
        missingFields.push("Location (for this Report)");
      }
    } catch (error) {
      console.warn('Error checking location:', error);
      missingFields.push("Location (for this Report)");
    }

    return missingFields;
  }

  async function exportPDF(){
    // Check if PDF generation is already in progress
    if(isGeneratingPDF) {
      showError("PDF generation already in progress. Please wait...");
      return;
    }
    
    const jid = getCur(); 
    if(!jid){ 
      showError("No Report ID selected."); 
      return; 
    }

    // Validate required fields before export
    const missingFields = await validateRequiredForExport(jid);
    if (missingFields.length > 0) {
      const missingList = missingFields.map(field => `• ${field}`).join('\n');
      alert(`Please complete the following required fields:\n\n${missingList}`);
      return;
    }
    
    const items = await loadItems(jid); 
    if(!items.length){ 
      showError("Add at least one card before exporting PDF."); 
      return; 
    }
    
    const attachedJobName = await findJobNameForJobId(jid);
    if(!attachedJobName) {
      showError("This Report ID must be attached to a Report Name first. Use the big red 'Create Report Name' button and drag this Report ID onto it.");
      return;
    }
    
    // Show filename modal
    await showPDFFilenameModal(jid, attachedJobName, items);
  }

  async function showPDFFilenameModal(jid, reportNameEntry, items) {
    // Create modal HTML
    const modal = document.createElement('div');
    modal.className = 'overlay';
    modal.innerHTML = `
      <section class="sheet small" role="dialog" aria-modal="true">
        <header class="bar">
          <h3 class="title">Export PDF Report</h3>
        </header>
        <div class="content">
          <div style="margin-bottom: 16px; padding: 12px; background: #1f2937; border-radius: 8px;">
            <div style="color: #22c55e; font-weight: 600;">✅ Ready to Export</div>
            <div style="margin-top: 8px; font-size: 14px; color: #94a3b8;">
              <div>Report Name: <strong>${reportNameEntry && reportNameEntry.label ? reportNameEntry.label : 'No Report Name Attached'}</strong></div>
              <div>Report ID: <strong>${jid}</strong></div>
              <div>Cards: <strong>${items.length} item${items.length === 1 ? '' : 's'}</strong></div>
            </div>
          </div>
          <label style="display: block; margin-bottom: 12px;">
            <span style="display: block; margin-bottom: 4px;">Job Name:</span>
            <input id="pdf-job-name-input" class="input" style="width: 100%;" 
                   value="" placeholder="Enter job name (required)">
          </label>
          <div style="display: block; margin-bottom: 12px; padding: 8px; background: #0f1419; border-radius: 6px;">
            <span style="display: block; margin-bottom: 4px; font-size: 14px; color: #94a3b8;">Generated Filename:</span>
            <div id="pdf-filename-display" style="font-family: monospace; font-size: 14px; color: #22c55e; word-break: break-all;"></div>
          </div>
          <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
            <input id="pdf-confidential-checkbox" type="checkbox" style="margin: 0;">
            <span>Confidential?</span>
          </label>
        </div>
        <footer class="bar" style="display: flex; gap: 8px; justify-content: flex-end;">
          <button id="pdf-generate-btn" class="btn btn-green">Generate PDF</button>
          <button id="pdf-cancel-btn" class="btn">Cancel</button>
        </footer>
      </section>
    `;
    
    document.body.appendChild(modal);
    
    // Function to generate filename based on job code, report name, and date
    function generateFilename() {
      const jobNameInput = modal.querySelector('#pdf-job-name-input');
      const jobCodeFromField = document.getElementById('job-code')?.value?.trim() || '';
      const reportName = reportNameEntry && reportNameEntry.label ? reportNameEntry.label : '';
      const currentDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      
      let filename = '';
      
      // Add job code if it exists (with underscores for spaces)
      if (jobCodeFromField) {
        filename += jobCodeFromField.replace(/\s+/g, '_') + '_';
      }
      
      // Add report name (with spaces, no underscores)
      if (reportName) {
        filename += reportName + '_';
      }
      
      // Add date with underscores
      filename += currentDate.replace(/-/g, '_');
      
      // Add unique timestamp to ensure each PDF is unique (HH-MM-SS)
      const now = new Date();
      const timestamp = now.getHours().toString().padStart(2, '0') + '-' +
                       now.getMinutes().toString().padStart(2, '0') + '-' +
                       now.getSeconds().toString().padStart(2, '0');
      filename += '_' + timestamp;
      
      // Add .pdf extension
      filename += '.pdf';
      
      return filename;
    }

    // Deduplicate filename against existing PDFs
    async function deduplicateFilename(baseFilename) {
      const pdfs = await loadPDFs();
      const existingFilenames = pdfs.map(pdf => pdf.filename);
      
      if (!existingFilenames.includes(baseFilename)) {
        return baseFilename; // No duplicate
      }
      
      // Find the next available number
      const baseName = baseFilename.replace(/\.pdf$/i, '');
      let counter = 1;
      let newFilename = `${baseName} (${counter}).pdf`;
      
      while (existingFilenames.includes(newFilename)) {
        counter++;
        newFilename = `${baseName} (${counter}).pdf`;
      }
      
      return newFilename;
    }
    
    // Update filename display
    function updateFilenameDisplay() {
      const filenameDisplay = modal.querySelector('#pdf-filename-display');
      const filename = generateFilename();
      filenameDisplay.textContent = filename;
    }
    
    // Initial filename generation
    updateFilenameDisplay();
    
    // Update filename when job name changes
    modal.querySelector('#pdf-job-name-input').addEventListener('input', updateFilenameDisplay);
    
    // Event listeners
    modal.querySelector('#pdf-generate-btn').addEventListener('click', async () => {
      const jobName = modal.querySelector('#pdf-job-name-input').value.trim();
      const filename = generateFilename(); // Use generated filename
      const isConfidential = modal.querySelector('#pdf-confidential-checkbox').checked;
      const generateBtn = modal.querySelector('#pdf-generate-btn');
      
      if(!jobName) {
        showError('Please enter a job name');
        return;
      }
      
      // Update button state to show generation in progress
      const originalText = generateBtn.textContent;
      generateBtn.textContent = 'Generating PDF...';
      generateBtn.disabled = true;
      
      try {
        // Add progress feedback for iOS devices
        let progressCount = 0;
        const progressInterval = setInterval(() => {
          progressCount++;
          generateBtn.textContent = `Generating PDF${'.'.repeat((progressCount % 3) + 1)}`;
        }, 500);
        
        document.body.removeChild(modal);
        const uniqueFilename = await deduplicateFilename(filename);
        await generatePDF(jid, reportNameEntry, items, uniqueFilename, isConfidential, jobName);
        clearInterval(progressInterval);
      } catch (error) {
        console.error('PDF generation failed:', error);
        clearInterval(progressInterval);
        showError(`PDF generation failed: ${error.message}. Please try again with fewer images or shorter text.`);
        // Reset button if modal still exists (unlikely but safe)
        if (document.body.contains(modal)) {
          generateBtn.textContent = originalText;
          generateBtn.disabled = false;
        }
      }
    });
    
    modal.querySelector('#pdf-cancel-btn').addEventListener('click', () => {
      document.body.removeChild(modal);
    });
    
    // Focus job name input instead of filename
    setTimeout(() => {
      const input = modal.querySelector('#pdf-job-name-input');
      input.focus();
    }, 100);
  }

  // Helper function to truncate PDF filenames for display
  function truncateFilename(filename, maxLength = 33) {
    if (filename.length <= maxLength) return filename;
    const extension = filename.endsWith('.pdf') ? '.pdf' : '';
    const nameWithoutExt = extension ? filename.slice(0, -4) : filename;
    const truncated = nameWithoutExt.substring(0, maxLength - extension.length - 2) + '..' + extension;
    return truncated;
  }

  // Helper function to wrap long text with hyphenation for PDF
  function wrapLongText(doc, text, maxWidth, fontSize, fontStyle = 'bold') {
    doc.setFontSize(fontSize);
    doc.setFont('helvetica', fontStyle);
    
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';
    
    for (let word of words) {
      // Handle very long words by adding hyphens every 20 characters
      if (word.length > 20) {
        const hyphenatedParts = [];
        for (let i = 0; i < word.length; i += 20) {
          let part = word.substring(i, i + 20);
          if (i + 20 < word.length) part += '-';
          hyphenatedParts.push(part);
        }
        
        // Process each hyphenated part individually (don't rejoin with spaces!)
        for (let part of hyphenatedParts) {
          const testLine = currentLine + (currentLine ? ' ' : '') + part;
          const testWidth = doc.getTextWidth(testLine);
          
          if (testWidth > maxWidth && currentLine) {
            lines.push(currentLine);
            currentLine = part;
          } else {
            currentLine = testLine;
          }
        }
      } else {
        // Regular word processing
        const testLine = currentLine + (currentLine ? ' ' : '') + word;
        const testWidth = doc.getTextWidth(testLine);
        
        if (testWidth > maxWidth && currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      }
    }
    
    if (currentLine) {
      lines.push(currentLine);
    }
    
    return lines;
  }

  // Helper function to load logo as base64
  function loadLogoAsBase64(logoPath, callback) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = function() {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      
      // Fill white background (in case logo is transparent)
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      
      const base64 = canvas.toDataURL('image/png');
      callback(base64);
    };
    img.onerror = function() {
      console.warn('Failed to load logo:', logoPath, '- Logo file not found, using fallback');
      callback(null);
    };
    img.src = logoPath;
  }

  // Helper function to process title logo: add black background and invert colors
  function processInvertedLogo(logoPath, callback) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = function() {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      
      // Fill black background first
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // Draw the image (white logo on transparent)
      ctx.drawImage(img, 0, 0);
      
      // Get image data to invert colors
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      
      // Invert colors: white becomes black, black becomes white
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 255 - data[i];       // Red
        data[i + 1] = 255 - data[i + 1]; // Green  
        data[i + 2] = 255 - data[i + 2]; // Blue
        // Alpha channel (data[i + 3]) stays the same
      }
      
      // Put the inverted image data back
      ctx.putImageData(imageData, 0, 0);
      
      const base64 = canvas.toDataURL('image/png');
      callback(base64);
    };
    img.onerror = function() {
      console.warn('Failed to load logo for processing:', logoPath, '- Logo file not found, using fallback');
      callback(null);
    };
    img.src = logoPath;
  }

  // Helper function to convert hex color to RGB
  function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : null;
  }

  // Helper function to wrap text within textbox bounds with hyphenation
  function wrapTextToBounds(text, availableWidth, doc) {
    if (!text) return [];
    
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';
    
    for (let word of words) {
      // Handle very long words by adding hyphens
      if (word.length > 20) {
        const hyphenatedParts = [];
        for (let i = 0; i < word.length; i += 20) {
          let part = word.substring(i, i + 20);
          if (i + 20 < word.length) part += '-';
          hyphenatedParts.push(part);
        }
        word = hyphenatedParts.join(' ');
      }
      
      const testLine = currentLine + (currentLine ? ' ' : '') + word;
      const testWidth = doc.getTextWidth(testLine);
      
      if (testWidth > availableWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    
    if (currentLine) {
      lines.push(currentLine);
    }
    
    return lines;
  }

  // NEW: Smart textbox rendering with proper coordinate recalculation  
  function renderTextboxesOnOriginalImage(doc, texts, imgX, imgY, pdfWidth, pdfHeight, originalImageDimensions, scaledCanvasDimensions) {
    if (!texts || !Array.isArray(texts) || texts.length === 0) return;
    
    console.log(`=== TEXTBOX RENDERING DEBUG ===`);
    console.log(`Original image: ${originalImageDimensions.width}x${originalImageDimensions.height}`);
    console.log(`Scaled canvas: ${scaledCanvasDimensions.width}x${scaledCanvasDimensions.height}`);
    console.log(`PDF image: ${Math.round(pdfWidth)}x${Math.round(pdfHeight)} at (${Math.round(imgX)},${Math.round(imgY)})`);
    console.log(`Processing ${texts.length} textboxes`);
    
    // Deduplication check - prevent double rendering
    const renderedBoxes = new Set();
    
    // Calculate scale factors between GUI canvas and original image
    const guiToOriginalScale = {
      x: originalImageDimensions.width / scaledCanvasDimensions.width,
      y: originalImageDimensions.height / scaledCanvasDimensions.height
    };
    
    // Calculate PDF scale factors from original image to PDF
    const originalToPdfScale = {
      x: pdfWidth / originalImageDimensions.width,
      y: pdfHeight / originalImageDimensions.height
    };
    
    console.log(`Scale factors: GUI→Original(${guiToOriginalScale.x.toFixed(3)},${guiToOriginalScale.y.toFixed(3)}), Original→PDF(${originalToPdfScale.x.toFixed(3)},${originalToPdfScale.y.toFixed(3)})`);
    
    texts.forEach(function(textBox, index) {
      if (!textBox) return;
      
      // Create unique identifier for deduplication
      const boxId = `${textBox.x}_${textBox.y}_${textBox.w}_${textBox.h}`;
      if (renderedBoxes.has(boxId)) {
        console.warn(`Skipping duplicate textbox ${index} at (${textBox.x},${textBox.y})`);
        return;
      }
      renderedBoxes.add(boxId);
      
      console.log(`\n--- Textbox ${index} ---`);
      console.log(`Input:`, {
        x: textBox.x, y: textBox.y, w: textBox.w, h: textBox.h,
        text: (textBox.text || textBox.content || '').substring(0, 30) + '...',
        fontSize: textBox.fontSize, bgColor: textBox.bgColor
      });
      
      // Step 1: Convert GUI canvas coordinates to original image coordinates
      const originalCoords = {
        x: textBox.x * guiToOriginalScale.x,
        y: textBox.y * guiToOriginalScale.y,
        w: textBox.w * guiToOriginalScale.x,
        h: textBox.h * guiToOriginalScale.y
      };
      
      // Step 2: Convert original image coordinates to PDF coordinates
      const pdfCoords = {
        x: imgX + (originalCoords.x * originalToPdfScale.x),
        y: imgY + (originalCoords.y * originalToPdfScale.y),
        w: originalCoords.w * originalToPdfScale.x,
        h: originalCoords.h * originalToPdfScale.y
      };
      
      console.log(`GUI coords: (${Math.round(textBox.x)},${Math.round(textBox.y)},${Math.round(textBox.w)},${Math.round(textBox.h)})`);
      console.log(`Original coords: (${Math.round(originalCoords.x)},${Math.round(originalCoords.y)},${Math.round(originalCoords.w)},${Math.round(originalCoords.h)})`);
      console.log(`PDF coords: (${Math.round(pdfCoords.x)},${Math.round(pdfCoords.y)},${Math.round(pdfCoords.w)},${Math.round(pdfCoords.h)})`);
      
      // Step 3: Render textbox with exact bounds
      renderTextboxWithBounds(doc, textBox, pdfCoords.x, pdfCoords.y, pdfCoords.w, pdfCoords.h, originalToPdfScale);
    });
    
    console.log(`=== END TEXTBOX DEBUG ===\n`);
  }

  // Helper function to render individual textbox with strict bounds checking
  function renderTextboxWithBounds(doc, textBox, x, y, w, h, scale) {
    console.log(`Rendering textbox at PDF coords: (${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)})`);
    
    // Validate coordinates - prevent negative or zero dimensions
    if (w <= 0 || h <= 0) {
      console.warn(`Invalid textbox dimensions: ${w}x${h}, skipping`);
      return;
    }
    
    // Get exact background color from textbox
    const bgColor = textBox.bgColor || textBox.backgroundColor || "#E53935";
    const rgb = hexToRgb(bgColor);
    
    if (rgb) {
      // Draw background with proper opacity
      doc.setFillColor(rgb.r, rgb.g, rgb.b);
      try {
        doc.setGState(doc.GState({opacity: 0.85}));
      } catch(e) {
        console.warn('Opacity not supported');
      }
      
      // Draw background box with rounded corners (exactly as GUI)
      doc.roundedRect(x, y, w, h, 6, 6, 'F');
      console.log(`Drew background at (${Math.round(x)},${Math.round(y)}) size ${Math.round(w)}x${Math.round(h)}`);
      
      // Reset opacity for text
      try {
        doc.setGState(doc.GState({opacity: 1}));
      } catch(e) {
        // Ignore
      }
    }
    
    // Set text color to black
    doc.setTextColor(0, 0, 0);
    
    // IMPROVED: Better font size conversion for higher resolution
    const guiFontSize = textBox.fontSize || 24;
    // Use 1:1 scaling first, then apply minimal conversion
    const pdfFontSize = guiFontSize * 1.0; // Try 1:1 first for better resolution
    doc.setFontSize(pdfFontSize);
    doc.setFont('helvetica', 'normal');
    console.log(`Font size: GUI=${guiFontSize}, PDF=${pdfFontSize}`);
    
    // Calculate text area with exact GUI padding
    // NOTE: Padding should be in PDF coordinate space, not scaled twice
    const paddingX = 12; // Use direct PDF points instead of scaled
    const paddingY = 12;
    const availableWidth = w - (paddingX * 2);
    const availableHeight = h - (paddingY * 2);
    
    console.log(`Text area: ${Math.round(availableWidth)}x${Math.round(availableHeight)} (padding: ${paddingX}px)`);
    
    // Get text content
    let textContent = '';
    if (textBox.lines && Array.isArray(textBox.lines) && textBox.lines.length > 0) {
      textContent = textBox.lines.join(' '); // Join lines with spaces for rewrapping
    } else if (textBox.text) {
      textContent = textBox.text;
    } else if (textBox.content) {
      textContent = textBox.content;
    }
    
    if (textContent && textContent.trim()) {
      console.log(`Text content: "${textContent.substring(0, 50)}..."`);
      
      // Wrap text to fit within bounds
      const wrappedLines = wrapTextToBounds(textContent.trim(), availableWidth, doc);
      
      // Calculate line height (match GUI exactly)
      const lineHeight = pdfFontSize * 1.35;
      
      // Render lines, clipping to available height
      const maxLines = Math.floor(availableHeight / lineHeight);
      const linesToRender = wrappedLines.slice(0, maxLines);
      
      console.log(`Will render ${linesToRender.length}/${wrappedLines.length} lines (max ${maxLines} fit in height)`);
      
      linesToRender.forEach((line, lineIndex) => {
        if (line.trim()) {
          const textX = x + paddingX;
          const textY = y + paddingY + pdfFontSize + (lineIndex * lineHeight);
          
          // Ensure text stays within bounds
          if (textY <= y + h - paddingY) {
            doc.text(line.trim(), textX, textY);
            console.log(`Rendered line ${lineIndex}: "${line}" at (${Math.round(textX)},${Math.round(textY)})`);
          }
        }
      });
    }
  }


  // Helper function to set content opacity for confidential docs
  function setContentOpacity(doc, isConfidential) {
    if (isConfidential) {
      try {
        doc.setGState(doc.GState({opacity: 0.25}));
      } catch(e) {
        console.warn('Opacity not supported');
      }
    }
  }

  // Helper function to add watermark as final layer if confidential  
  function addConfidentialWatermark(doc, isConfidential, W, H) {
    if (!isConfidential) return;
    
    try {
      // Reset opacity and add watermark as top layer
      doc.setGState(doc.GState({opacity: 0.8})); 
      doc.setFontSize(36);
      doc.setTextColor(128, 128, 128);
      
      // Diagonal watermark pattern
      for(let x = -200; x < W + 200; x += 200) {
        for(let y = -200; y < H + 200; y += 150) {
          doc.text("Johnson-Lancaster & Associates Inc. Sensitive Document", x, y, {
            angle: 45,
            align: 'left'
          });
        }
      }
      doc.setGState(doc.GState({opacity: 1})); // Reset for next page
    } catch(e) {
      console.warn('Watermark not supported:', e);
    }
  }

  function generatePDFLetter(index) {
    if (index < 26) {
      return String.fromCharCode(65 + index); // A, B, C...
    } else {
      const firstLetter = Math.floor((index - 26) / 26);
      const secondLetter = (index - 26) % 26;
      return String.fromCharCode(65 + firstLetter) + String.fromCharCode(65 + secondLetter); // AA, AB...
    }
  }
  
  function renderNotePage(doc, noteItem, letterIndex, reportNameEntry, headerLogoData, isConfidential, W, H, pageNum, totalPages) {
    // Header with centered logo and styled title (same as image pages)
    const logoMargin = 21; // ~5/17 inch professional margins
    const logoSize = 30;
    
    if (headerLogoData) {
      try {
        doc.addImage(headerLogoData, "PNG", logoMargin, logoMargin, logoSize, logoSize);
      } catch(e) {
        console.warn('Header logo failed:', e);
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.text('JL', logoMargin, logoMargin + 15);
      }
    } else {
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.text('JL', logoMargin, logoMargin + 15);
    }
    
    // Smaller, cursive, centered header text
    const headerText = 'Johnson-Lancaster Commentated Operation Report';
    doc.setFontSize(11);
    doc.setFont('times', 'italic');
    const headerWidth = doc.getTextWidth(headerText);
    const centerX = (W - headerWidth) / 2;
    doc.text(headerText, centerX, 35);
    
    // Add Report Name to header
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`Report: ${reportNameEntry && reportNameEntry.label ? reportNameEntry.label : 'Unknown Report'}`, W - 40, 55, {align: 'right'});
    
    // Note title with letter
    const letter = generatePDFLetter(letterIndex);
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    
    // Render "General Notes " first (black, bold)
    doc.setTextColor(0, 0, 0);
    const generalPart = 'General Notes ';
    doc.text(generalPart, 40, 80);
    const generalWidth = doc.getTextWidth(generalPart);
    
    // Render blue letter (bold)
    doc.setTextColor(37, 99, 235); // Blue (#2563EB)
    const letterPart = letter;
    doc.text(letterPart, 40 + generalWidth, 80);
    const letterWidth = doc.getTextWidth(letterPart);
    
    // Render black period and optional name (normal text)
    doc.setTextColor(0, 0, 0);
    doc.setFont('helvetica', 'normal');
    let restText = '.';
    if(noteItem.name && noteItem.name.trim()) {
      restText = `. ${noteItem.name.trim()}`;
    }
    doc.text(restText, 40 + generalWidth + letterWidth, 80);
    
    // Black underline ONLY under "General Notes {Letter}"
    const underlineWidth = generalWidth + letterWidth;
    doc.setLineWidth(0.5);
    doc.setDrawColor(0, 0, 0);
    doc.line(40, 82, 40 + underlineWidth, 82);
    
    // Blue content box
    doc.setFillColor(230, 240, 255); // #E6F0FF
    doc.setDrawColor(178, 204, 255); // #B2CCFF
    doc.setLineWidth(2);
    const contentBoxX = 40, contentBoxY = 100, contentBoxWidth = W - 80, contentBoxHeight = 300;
    doc.roundedRect(contentBoxX, contentBoxY, contentBoxWidth, contentBoxHeight, 8, 8, 'FD');
    
    // Content text
    doc.setFontSize(11);
    doc.setTextColor(0, 0, 0);
    const content = noteItem.content && noteItem.content.trim() ? noteItem.content.trim() : "(No content)";
    
    if(content === "(No content)") {
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(100, 100, 100);
    } else {
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(0, 0, 0);
    }
    
    // Text wrapping in the blue box
    const lines = doc.splitTextToSize(content, contentBoxWidth - 20);
    doc.text(lines, contentBoxX + 10, contentBoxY + 20);
    
    // Footer
    doc.setFontSize(10);
    doc.setTextColor(150, 150, 150);
    doc.text('Internal - Confidentiality', 40, H-25);
    doc.text(`JOHNSON-LANCASTER AND ASSOCIATES, INC. - ${new Date().toLocaleDateString('en-US')} at ${new Date().toLocaleTimeString('en-US')}`, 40, H-10);
    doc.text(`Page ${pageNum} of ${totalPages}`, W-100, H-10);
    doc.setTextColor(0, 0, 0);
    
    // Add watermark as final layer
    addConfidentialWatermark(doc, isConfidential, W, H);
  }

  async function generatePDF(jid, reportNameEntry, items, filename, isConfidential, jobName) {
    const J = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if(!J){ 
      showError("PDF library unavailable"); 
      return; 
    }
    
    // Set generation lock
    isGeneratingPDF = true;
    console.log('PDF generation lock acquired');
    
    // Mobile-aware timeout - longer for mobile devices due to slower processing
    const isMobileDevice = window.navigator.userAgent.match(/iPad|iPhone|iPod|Android/i);
    const timeoutDuration = isMobileDevice ? 60000 : 30000; // 60s for mobile, 30s for desktop
    const pdfTimeout = setTimeout(() => {
      if (isGeneratingPDF) {
        console.error(`PDF generation timed out after ${timeoutDuration/1000} seconds`);
        isGeneratingPDF = false;
        showError(`PDF generation timed out after ${timeoutDuration/1000} seconds. Try reducing the number of images or text content.`);
      }
    }, timeoutDuration);
    
    // Performance monitoring
    const performanceStart = performance.now();
    console.log(`PDF generation started at: ${new Date().toISOString()}`);
    
    // Create unique session ID to prevent race conditions
    const sessionId = `pdf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    console.log(`Starting PDF generation session: ${sessionId}`);
    
    // Get fresh items data in current order
    const allItems = await loadItems(jid);
    
    // Include all items (images and general notes) for PDF
    const orderedItems = allItems;
    console.log(`[PDF] Filtered ${allItems.length - orderedItems.length} note cards from PDF export`);
    
    // Validate that we have actual image items to export
    if (orderedItems.length === 0 && allItems.length > 0) {
      clearTimeout(pdfTimeout);
      isGeneratingPDF = false;
      showError("No image items found to export. Note cards cannot be included in PDF reports.");
      return;
    }
    
    const reportId = jid;
    const doc = new J({orientation:"portrait", unit:"pt", format:"a4"});
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
    
    // Set PDF metadata with proper filename for browser native download
    const cleanFilename = filename.replace(/\.pdf$/i, '') + '.pdf';
    doc.setProperties({
      title: cleanFilename,
      subject: `JL Annotator Report - ${reportId}`,
      author: 'JL Annotator',
      creator: 'JL Annotator App'
    });
    
    // Load settings data from IndexedDB
    let settings = {};
    try {
      if (window.IndexedStorage && window.IndexedStorage.Storage) {
        const settingsData = await window.IndexedStorage.Storage.getItem("JL_settings_v2");
        settings = settingsData ? JSON.parse(settingsData) : {};
      }
    } catch(e) {
      console.warn('Failed to load settings for PDF:', e);
      settings = {};
    }

    // Load per-report location
    let reportLocation = '';
    try {
      reportLocation = await loadLocation(jid);
    } catch(e) {
      console.warn('Failed to load location for PDF:', e);
    }
    
    // Instance-specific logo loading (completely isolated per session)
    const pdfSession = {
      id: sessionId,
      headerLogo: null,
      titleLogo: null,
      logosLoaded: 0,
      isComplete: false,
      performanceStart: performanceStart
    };
    
    function checkLogosLoadedAndGenerate() {
      if (pdfSession.isComplete) {
        console.warn(`PDF session ${sessionId} already completed - ignoring callback`);
        return;
      }
      
      pdfSession.logosLoaded++;
      console.log(`Session ${sessionId}: ${pdfSession.logosLoaded}/2 logos loaded`);
      
      if (pdfSession.logosLoaded >= 2) {
        pdfSession.isComplete = true;
        generatePDFWithLogos(pdfSession.headerLogo, pdfSession.titleLogo).catch(error => {
          console.error('PDF generation failed:', error);
          clearTimeout(pdfTimeout);
          isGeneratingPDF = false;
          console.log('PDF generation lock released due to error');
          showError('PDF generation failed: ' + error.message);
        });
      }
    }
    
    loadLogoAsBase64('assets/jl-logo-header.png', function(logo) {
      if (!pdfSession.isComplete) {
        pdfSession.headerLogo = logo;
        checkLogosLoadedAndGenerate();
      }
    });
    
    // Process and load inverted title logo for visibility on white background  
    processInvertedLogo('assets/jl-logo-title.png', function(logo) {
      if (!pdfSession.isComplete) {
        pdfSession.titleLogo = logo;
        checkLogosLoadedAndGenerate();
      }
    });
    
    async function generatePDFWithLogos(headerLogoData, titleLogoData) {
      // Pre-generate all pin area images before PDF generation
      const pinImagePromises = orderedItems.map(async (item, index) => {
        const linkedPin = window.FloorPlans ? await window.FloorPlans.getCardLinkedPin(item.id) : null;
        const itemPins = linkedPin ? [linkedPin] : [];
        if (itemPins.length > 0) {
          const pin = itemPins[0];
          if (pin.floorPlanCardId) {
            const floorPlan = await getFloorPlanForPin(pin);
            if (floorPlan && floorPlan.src) {
              try {
                return await generatePinAreaImageAsync(pin, floorPlan);
              } catch (error) {
                console.error(`Error generating pin image for item ${index + 1}:`, error);
                return null;
              }
            }
          }
        }
        return null;
      });
      
      const pinImages = await Promise.all(pinImagePromises);
      console.log('Pre-generated pin images:', pinImages.map((img, i) => img ? `Item ${i+1}: generated` : `Item ${i+1}: none`).join(', '));
      
      // Now generate PDF with pre-generated pin images
      await generatePDFWithPinImages(headerLogoData, titleLogoData, pinImages);
    }
    
    async function generatePDFWithPinImages(headerLogoData, titleLogoData, pinImages) {
    console.log(`[PIN DEBUG] generatePDFWithPinImages called with pinImages: ${pinImages ? `array length ${pinImages.length}` : 'undefined'}`);
    if (pinImages) {
      pinImages.forEach((img, index) => {
        console.log(`[PIN DEBUG] pinImages[${index}]: ${img ? 'present' : 'null'} ${img ? `(${img.length} chars)` : ''}`);
      });
    }
    
    // Load signature data from IndexedDB or localStorage fallback
    let signatureData = null;
    try {
      if (window.IndexedStorage && window.IndexedStorage.Storage) {
        signatureData = await window.IndexedStorage.Storage.getItem("JL_signature_png");
      }
      if (!signatureData) {
        // Fallback to localStorage
        signatureData = localStorage.getItem("JL_signature_png");
      }
    } catch(e) {
      signatureData = null;
    }
    
    
    // ===== TITLE PAGE =====
    setContentOpacity(doc, isConfidential);
    
    // Company Logo - properly sized and positioned
    if (titleLogoData) {
      try {
        const logoWidth = 280;  // Standardized width for better proportion
        const logoHeight = 200; // Proportional height
        const logoX = (W - logoWidth) / 2;
        const logoY = 80; // Consistent top positioning
        doc.addImage(titleLogoData, "PNG", logoX, logoY, logoWidth, logoHeight);
      } catch(e) {
        console.warn('Title logo loading failed:', e);
        // Professional fallback text
        doc.setFontSize(32);
        doc.setFont('helvetica', 'bold');  
        doc.text('Johnson-Lancaster', W/2, 140, {align: 'center'});
      }
    } else {
      // Professional fallback text if logo failed to load
      doc.setFontSize(32);
      doc.setFont('helvetica', 'bold');
      doc.text('Johnson-Lancaster', W/2, 140, {align: 'center'});
    }
    
    // Professional horizontal divider - properly positioned
    doc.setLineWidth(1.5);
    doc.setDrawColor(0, 0, 0);
    doc.line(100, 310, W-100, 310);
    
    // Report title - improved spacing and typography
    doc.setFontSize(24);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 0, 0);
    doc.text('Operation Report', W/2, 340, {align: 'center'});
    
    // Job name - cleaner presentation
    doc.setFontSize(20);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(60, 60, 60); // Dark grey for better contrast
    doc.text(reportNameEntry && reportNameEntry.label ? reportNameEntry.label : 'Unknown Report', W/2, 365, {align: 'center'});
    
    // Reset styling
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(0, 0, 0);
    
    let titleYPos = 365; // Update position for following elements
    
    // Revision and confidentiality - better positioning
    const revisionYPos = titleYPos + 40; 
    doc.setFontSize(14);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(80, 80, 80);
    // doc.text('Revision A', W/2, revisionYPos, {align: 'center'}); // Removed as requested
    
    if (isConfidential) {
      doc.setFontSize(12);
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(200, 0, 0); // Red for confidential
      doc.text('CONFIDENTIAL', W/2, revisionYPos + 20, {align: 'center'});
    }
    
    // Metadata section - cleaner layout
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(0, 0, 0);
    const metadataStartY = revisionYPos + 60;
    const leftMargin = 100;
    const rightMargin = W - 200;
    
    // Get Job Code from library interface
    const jobCodeInput = document.getElementById('job-code');
    const jobCode = jobCodeInput ? jobCodeInput.value.trim() : '';
    
    // Optional data positioned in upper area - using new field structure
    const optionalData = [];
    
    if (settings.name) optionalData.push(`Name: ${settings.name}`);
    if (settings.mail) optionalData.push(`Email: ${settings.mail}`);
    if (settings.occ) optionalData.push(`Occupation: ${settings.occ}`);
    if (settings.phone) optionalData.push(`Contact Phone: ${settings.phone}`);
    if (reportLocation) optionalData.push(`Location: ${reportLocation}`);
    
    // Position optional data in upper area with same spacing as mandatory data had
    if (optionalData.length > 0) {
      let optionalYPos = metadataStartY;
      optionalData.forEach(data => {
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(0, 0, 0);
        doc.text(data, leftMargin, optionalYPos);
        optionalYPos += 20;
      });
    }
    
    // Mandatory data - positioned at bottom-left above footer
    const footerY = H - 80; // Footer starts around here
    const mandatoryItemCount = jobCode ? 4 : 3; // Report ID, Job Name, Job Code (optional), Generated
    let mandatoryYPos = footerY - 30 - (mandatoryItemCount * 20);
    
    // Report ID - Red, bold, underlined (except colon)
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(220, 38, 38); // Red color
    doc.text('Report ID', leftMargin, mandatoryYPos);
    const reportIdWidth = doc.getTextWidth('Report ID');
    doc.line(leftMargin, mandatoryYPos + 2, leftMargin + reportIdWidth, mandatoryYPos + 2); // Underline
    doc.setTextColor(0, 0, 0); // Black for colon and data
    doc.setFont('helvetica', 'normal');
    doc.text(`: ${jid}`, leftMargin + reportIdWidth, mandatoryYPos);
    mandatoryYPos += 20;
    
    // Job Name - Red, bold, underlined (except colon)
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(220, 38, 38); // Red color
    doc.text('Job Name', leftMargin, mandatoryYPos);
    const jobNameWidth = doc.getTextWidth('Job Name');
    doc.line(leftMargin, mandatoryYPos + 2, leftMargin + jobNameWidth, mandatoryYPos + 2); // Underline
    doc.setTextColor(0, 0, 0); // Black for colon and data
    doc.setFont('helvetica', 'normal');
    doc.text(`: ${jobName}`, leftMargin + jobNameWidth, mandatoryYPos);
    mandatoryYPos += 20;
    
    // Job Code - Red, bold, underlined (except colon) - only if provided
    if (jobCode) {
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(220, 38, 38); // Red color
      doc.text('Job Code', leftMargin, mandatoryYPos);
      const jobCodeWidth = doc.getTextWidth('Job Code');
      doc.line(leftMargin, mandatoryYPos + 2, leftMargin + jobCodeWidth, mandatoryYPos + 2); // Underline
      doc.setTextColor(0, 0, 0); // Black for colon and data
      doc.setFont('helvetica', 'normal');
      doc.text(`: ${jobCode}`, leftMargin + jobCodeWidth, mandatoryYPos);
      mandatoryYPos += 20;
    }
    
    // Generated - Normal text (no bold)
    doc.setTextColor(0, 0, 0);
    doc.text(`Generated: ${new Date().toLocaleDateString('en-US')} at ${new Date().toLocaleTimeString('en-US')}`, leftMargin, mandatoryYPos);
    
    // Footer
    doc.setFontSize(10);
    doc.setTextColor(150, 150, 150);
    doc.text('Internal - Confidentiality', W/2, H-40, {align: 'center'});
    doc.text(`JOHNSON-LANCASTER AND ASSOCIATES, INC. - ${new Date().toLocaleDateString('en-US')} at ${new Date().toLocaleTimeString('en-US')}`, W/2, H-25, {align: 'center'});
    
    // Reset text color and add watermark as final layer
    doc.setTextColor(0, 0, 0);
    addConfidentialWatermark(doc, isConfidential, W, H);
    
    // ===== ITEM PAGES =====
    let imageCounter = 1;
    let noteLetterIndex = 0;
    
    // Mobile resilience: Process items in chunks to prevent memory issues
    const CHUNK_SIZE = window.navigator.userAgent.match(/iPad|iPhone|iPod|Android/i) ? 3 : 5; // Smaller chunks on mobile
    
    for (let i = 0; i < orderedItems.length; i++) {
      // Yield control to UI every few items on mobile devices to prevent blocking
      if (i > 0 && i % CHUNK_SIZE === 0) {
        console.log(`[PDF Mobile] Processing chunk ${Math.floor(i / CHUNK_SIZE)}, yielding control...`);
        await new Promise(resolve => setTimeout(resolve, 100)); // Yield for 100ms
        
        // Memory cleanup hint for mobile browsers
        if (window.gc && typeof window.gc === 'function') {
          window.gc();
        }
      }
      const it = orderedItems[i];
      doc.addPage();
      setContentOpacity(doc, isConfidential);
      
      if(it.type === "note") {
        // Calculate total pages: 1 (title) + items + 1 (signature if exists)
        const totalPagesForNote = 1 + orderedItems.length + (signatureData ? 1 : 0);
        renderNotePage(doc, it, noteLetterIndex, reportNameEntry, headerLogoData, isConfidential, W, H, i + 2, totalPagesForNote);
        noteLetterIndex++;
        continue; // Skip the rest of the image rendering logic for this iteration
      }
      
      // Header with centered logo and styled title
      const logoMargin = 21; // ~5/17 inch professional margins
      const logoSize = 30;
      
      if (headerLogoData) {
        try {
          doc.addImage(headerLogoData, "PNG", logoMargin, logoMargin, logoSize, logoSize);
        } catch(e) {
          console.warn('Header logo failed:', e);
          doc.setFontSize(12);
          doc.setFont('helvetica', 'bold');
          doc.text('JL', logoMargin, logoMargin + 15);
        }
      } else {
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.text('JL', logoMargin, logoMargin + 15);
      }
      
      // Smaller, cursive, centered header text
      const headerText = 'Johnson-Lancaster Commentated Operation Report';
      doc.setFontSize(11);
      doc.setFont('times', 'italic');
      const headerWidth = doc.getTextWidth(headerText);
      const centerX = (W - headerWidth) / 2;
      doc.text(headerText, centerX, 35);
      
      // Add Report Name to header (smaller font, repositioned to avoid collision)
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.text(`Report: ${reportNameEntry && reportNameEntry.label ? reportNameEntry.label : 'Unknown Report'}`, W - 40, 55, {align: 'right'});
      
      // Item title with red accent number (no gaps)
      doc.setFontSize(16);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(0, 0, 0); // Black for "ITEM"
      
      // Render "ITEM " first
      const itemPart = 'ITEM ';
      doc.text(itemPart, 40, 80);
      const itemWidth = doc.getTextWidth(itemPart);
      
      // Render red number immediately after "ITEM "
      doc.setTextColor(255, 0, 0); // Red for number
      const numberPart1 = `${imageCounter}`;
      doc.text(numberPart1, 40 + itemWidth, 80);
      const numberWidth = doc.getTextWidth(numberPart1);
      
      // Render black period immediately after number
      doc.setTextColor(0, 0, 0); // Black for period
      const periodPart = '.';
      doc.text(periodPart, 40 + itemWidth + numberWidth, 80);
      
      // Check for floor plan pins linked to this item and add pin indicator
      let pinIndicatorWidth = 0;
      const itemPins = await getFloorPlanPinsForItem(it.id);
      if (itemPins.length > 0) {
        // Add some spacing before the pin
        const pinSpacing = 8;
        const pinX = 40 + itemWidth + numberWidth + doc.getTextWidth(periodPart) + pinSpacing;
        const pinY = 80;
        
        // Use the first pin's color for the indicator
        const pinColor = itemPins[0].headColor;
        const rgb = hexToRgb(pinColor);
        
        // Draw small colored circle (pin indicator)
        doc.setFillColor(rgb.r, rgb.g, rgb.b);
        doc.setDrawColor(0, 0, 0); // Black border
        doc.setLineWidth(1);
        doc.circle(pinX, pinY - 3, 4, 'FD'); // Filled circle with border
        
        pinIndicatorWidth = 8 + pinSpacing; // Pin diameter + spacing
      }
      
      // Red underline ONLY for "ITEM X" (exclude the period and pin) - consistent with other headers
      const underlineWidth = itemWidth + numberWidth;
      doc.setLineWidth(1);
      doc.setDrawColor(0, 0, 0); // Black border for text boxes
      doc.line(40, 83, 40 + underlineWidth, 83);
      
      // Get pre-generated pin area image for this item
      console.log(`[PIN DEBUG] About to get pinImages[${i}], pinImages exists: ${!!pinImages}, array length: ${pinImages?.length}`);
      const pinAreaImageData = pinImages[i];
      console.log(`[PIN DEBUG] Retrieved pinAreaImageData for item ${i+1}: ${pinAreaImageData ? 'FOUND' : 'NOT FOUND'}`);
      
      if (pinAreaImageData) {
        console.log(`Using pre-generated pin area image for item ${i+1}`);
      }

      // Force compressed image usage for mobile PDF generation to prevent memory crashes
      const isMobileDevice = window.navigator.userAgent.match(/iPad|iPhone|iPod|Android/i);
      let src;
      
      if (isMobileDevice && it.url) {
        // On mobile, prioritize compressed image (url) to prevent PDF crashes
        src = it.url;
        console.log(`Item ${i+1} - Mobile device detected, using compressed image (url) for PDF`);
      } else {
        // Desktop can handle larger images
        src = it.composedUrl || it.baseUrl || it.url || "";
      }
      
      console.log(`Item ${i+1} image sources:`, {
        composedUrl: it.composedUrl ? 'present' : 'missing',
        baseUrl: it.baseUrl ? 'present' : 'missing', 
        url: it.url ? 'present' : 'missing',
        finalSrc: src ? 'present' : 'missing',
        isMobile: !!isMobileDevice,
        usingCompressed: isMobileDevice && src === it.url
      });
      
      if(src) {
        try {
          // Get ACTUAL canvas dimensions from the item data
          let canvasWidth = 800;  // Fallback only
          let canvasHeight = 600; // Fallback only
          
          // Priority 1: Get from canvas element if available
          if (it.canvas && it.canvas.width && it.canvas.height) {
            canvasWidth = it.canvas.width;
            canvasHeight = it.canvas.height;
            console.log(`Got canvas dimensions from canvas element: ${canvasWidth}x${canvasHeight}`);
          }
          // Priority 2: Get from item dimensions if stored
          else if (it.width && it.height) {
            canvasWidth = it.width;
            canvasHeight = it.height;
            console.log(`Got canvas dimensions from item data: ${canvasWidth}x${canvasHeight}`);
          }
          // Priority 3: Get from naturalWidth/naturalHeight if stored
          else if (it.naturalWidth && it.naturalHeight) {
            canvasWidth = it.naturalWidth;
            canvasHeight = it.naturalHeight;
            console.log(`Got canvas dimensions from natural size: ${canvasWidth}x${canvasHeight}`);
          }
          else {
            console.warn(`[PDF SIZE] Using fallback dimensions for item ${i+1}: ${canvasWidth}x${canvasHeight}`);
            console.warn(`[PDF SIZE] This will create a large image - actual image might be smaller!`);
          }
          
          // Calculate PDF dimensions with proper scaling
          const maxWidth = W - 80; // Page margins
          const maxHeight = 400; // Reasonable max height for readability
          
          let pdfWidth = canvasWidth;
          let pdfHeight = canvasHeight; 
          
          // Scale down if too large for page, maintaining aspect ratio
          if (canvasWidth > maxWidth || canvasHeight > maxHeight) {
            const scaleX = maxWidth / canvasWidth;
            const scaleY = maxHeight / canvasHeight;
            const scale = Math.min(scaleX, scaleY);
            
            pdfWidth = canvasWidth * scale;
            pdfHeight = canvasHeight * scale;
          }
          
          // Center horizontally in available space
          const imgX = (W - pdfWidth) / 2;
          const imgY = 95;
          
          // Auto-detect image format from data URL
          let format = "JPEG";
          if (src.startsWith('data:image/png') || src.includes('png')) {
            format = "PNG";
          } else if (src.startsWith('data:image/jpeg') || src.startsWith('data:image/jpg')) {
            format = "JPEG";
          }
          
          console.log(`Adding image ${i+1}: format=${format}, canvas=${canvasWidth}x${canvasHeight}, pdf=${Math.round(pdfWidth)}x${Math.round(pdfHeight)}, position=(${Math.round(imgX)},${imgY})`);
          
          // Mobile resilience: Check memory usage before processing large images
          const isMobileDevice = window.navigator.userAgent.match(/iPad|iPhone|iPod|Android/i);
          if (isMobileDevice && performance.memory) {
            const memUsage = performance.memory.usedJSHeapSize / 1048576; // MB
            const memLimit = performance.memory.jsHeapSizeLimit / 1048576; // MB
            console.log(`[PDF Mobile] Memory before image ${i+1}: ${memUsage.toFixed(1)}MB / ${memLimit.toFixed(1)}MB`);
            
            // If memory usage is high, yield and suggest cleanup
            if (memUsage > memLimit * 0.7) {
              console.warn(`[PDF Mobile] High memory usage detected (${memUsage.toFixed(1)}MB), yielding...`);
              await new Promise(resolve => setTimeout(resolve, 200));
            }
          }
          
          // Add image to PDF with mobile error handling
          try {
            doc.addImage(src, format, imgX, imgY, pdfWidth, pdfHeight);
          } catch (imgError) {
            if (imgError.message && (imgError.message.includes('memory') || imgError.message.includes('heap') || imgError.message.includes('size'))) {
              console.error(`Memory error adding image ${i+1}, attempting fallback with reduced quality`);
              // For mobile devices with memory issues, create a fallback error message
              if (isMobileDevice) {
                doc.setFontSize(12);
                doc.setTextColor(255, 0, 0);
                doc.text(`Image ${i+1} too large for mobile device memory`, imgX, imgY + 20);
                doc.text(`Try reducing image size or using fewer images`, imgX, imgY + 35);
                doc.setTextColor(0, 0, 0);
              } else {
                throw imgError;
              }
            } else {
              throw imgError;
            }
          }
          
          // Handle text annotations based on image source
          const isUsingCleanImage = (src === (it.baseUrl || it.url));
          const isUsingCompressedForMobile = (isMobileDevice && src === it.url && it.composedUrl);
          
          if (it.texts && Array.isArray(it.texts) && it.texts.length > 0 && (isUsingCleanImage || isUsingCompressedForMobile)) {
            console.log(`Rendering ${it.texts.length} text annotations for item ${i+1} ${isUsingCompressedForMobile ? '(mobile compressed)' : '(clean image)'}`);
            
            // Get original image dimensions (the true source image size)
            const originalImageDimensions = {
              width: it.naturalWidth || it.originalWidth || canvasWidth,
              height: it.naturalHeight || it.originalHeight || canvasHeight
            };
            
            // GUI canvas dimensions (what user sees and interacts with)  
            const scaledCanvasDimensions = {
              width: canvasWidth,
              height: canvasHeight
            };
            
            // Use new smart textbox rendering system
            renderTextboxesOnOriginalImage(doc, it.texts, imgX, imgY, pdfWidth, pdfHeight, originalImageDimensions, scaledCanvasDimensions);
          } else if (it.texts && Array.isArray(it.texts) && it.texts.length > 0) {
            console.log(`Skipping textbox overlay rendering for item ${i+1} - using composedUrl with flattened annotations`);
          }
          
        } catch(e) {
          console.error(`Failed to add image ${i+1}:`, e);
          doc.setFontSize(12);
          doc.text(`Image could not be embedded: ${e.message}`, 40, 120);
        }
      } else {
        console.warn(`No image data for item ${i+1}`);
        doc.setFontSize(12);
        doc.text("No image data available", 40, 120);
      }
      
      // Always create red box format for consistent presentation
      const hasNotes = it.notes && it.notes.trim();
      
      // Always create the red textbox format (whether notes exist or not)
      {
        const notesY = 480;
        
        // Calculate pin image space
        const hasPinImage = !!pinAreaImageData;
        const pinImageWidth = 249; // Adjusted for 765px canvas width (35px less than 800px)
        const pinImageHeight = 117; // Keep height the same
        const pinImageMargin = 5; // Reduced for better symmetry with textbox borders
        
        // Calculate available text width (subtract pin image space if present)
        const textAreaWidth = hasPinImage ? (W - 80) - (pinImageWidth + 20) : (W - 80) - 20;
        
        // Calculate precise textbox height based on actual text that will be rendered
        doc.setFontSize(11);
        doc.setFont('helvetica', 'normal');
        const allText = (it.notes && it.notes.trim()) || '';
        const lineHeight = 12;
        
        // Calculate how many lines will fit and be rendered in this box
        let actualTextLines = 0;
        if (allText) {
          // Estimate available height - allow more space for text, less for footer
          const estimatedMaxHeight = H - notesY - 60; // Reduced footer reserve from 100px to 60px
          const estimatedMaxLines = Math.floor(estimatedMaxHeight / lineHeight); // Header space already included in notesY positioning
          
          if (hasPinImage) {
            // Zone 1: up to 8 lines narrow, Zone 2: remaining full width
            const zone1MaxLines = Math.min(8, estimatedMaxLines);
            const zone2MaxLines = estimatedMaxLines - zone1MaxLines;
            
            const narrowWidth = (W - 80) - pinImageWidth - 15;
            const zone1Lines = doc.splitTextToSize(allText, narrowWidth);
            const zone1Portion = zone1Lines.slice(0, zone1MaxLines);
            actualTextLines += zone1Portion.length;
            
            // Calculate remaining text for Zone 2
            if (zone1Portion.length > 0 && zone2MaxLines > 0) {
              let searchPos = 0;
              for (let i = 0; i < zone1Portion.length; i++) {
                const line = zone1Portion[i].trim();
                const lineStart = allText.indexOf(line, searchPos);
                if (lineStart >= 0) {
                  searchPos = lineStart + line.length;
                }
              }
              const remainingText = allText.substring(searchPos).trim();
              
              if (remainingText) {
                const fullWidth = (W - 80) - 10;
                const zone2Lines = doc.splitTextToSize(remainingText, fullWidth);
                const zone2Portion = zone2Lines.slice(0, zone2MaxLines);
                actualTextLines += zone2Portion.length;
              }
            }
          } else {
            // No pin: Full width only
            const fullWidth = (W - 80) - 10;
            const allLines = doc.splitTextToSize(allText, fullWidth);
            const fittingLines = allLines.slice(0, estimatedMaxLines);
            actualTextLines = fittingLines.length;
          }
        }
        
        // Calculate precise dynamic height
        const baseHeight = hasPinImage ? 120 : 60; // Minimum height (120px for pin, 60px for no pin)
        const headerSpace = 30; // Space for "ITEM N. Notes & Location:" header
        const actualTextHeight = actualTextLines * lineHeight;
        const precisePadding = 8; // Minimal padding below text
        const contentBasedHeight = headerSpace + actualTextHeight + precisePadding;
        const dynamicHeight = Math.max(baseHeight, contentBasedHeight);
        
        // Box dimensions - will be rendered after text calculation
        const boxX = 40, boxY = notesY, boxWidth = W - 80;
        
        // Calculate pin image positioning (declare in outer scope for text flow access)
        const pinImageX = boxX + boxWidth - pinImageWidth - pinImageMargin - 0.5;
        const pinImageY = boxY + 1.5; // 1.5px gap from top border for perfect fit
        
        // Store pin image data for rendering AFTER red box (to ensure proper z-order)
        console.log(`[PIN DEBUG] Item ${i+1}: pinAreaImageData type=${typeof pinAreaImageData}, value=${pinAreaImageData ? 'present' : 'MISSING'}`);
        console.log(`[PIN DEBUG] pinImages array length: ${pinImages ? pinImages.length : 'undefined'}, item index: ${i}`);
        
        // SMART TEXT FLOW: Split text between original page and continuation page if needed
        const fullNoteText = (it.notes && it.notes.trim()) || '';
        
        if (fullNoteText) {
          // Calculate DYNAMIC max lines based on actual available space in the box
          const lineHeight = 12;
          const headerSpace = 30; // Space for item header
          const padding = 12; // Reduced padding for more text space
          const availableTextHeight = dynamicHeight - headerSpace - padding;
          const maxLinesInBox = Math.floor(availableTextHeight / lineHeight) + 1; // Add 1 line tolerance
          
          console.log(`[TextSplit] Dynamic max lines calculation: boxHeight=${dynamicHeight}, available=${availableTextHeight}, maxLines=${maxLinesInBox}`);
          
          // Split text based on available space in current box
          const { originalText, continuationText } = splitTextForAvailableSpace(
            fullNoteText, hasPinImage, maxLinesInBox, boxWidth, pinImageWidth
          );
          
          // Calculate actual box height based on text that will be rendered
          let actualLinesRendered = 0;
          if (originalText) {
            // Count lines that will actually be rendered
            if (hasPinImage) {
              const narrowWidth = boxWidth - pinImageWidth - 15;
              const zone1Lines = improvedSplitTextToSize(originalText, narrowWidth, doc).slice(0, 8);
              actualLinesRendered += zone1Lines.length;
              
              // Calculate remaining text for Zone 2
              let remainingForZone2 = originalText;
              if (zone1Lines.length > 0) {
                let searchPos = 0;
                for (let i = 0; i < zone1Lines.length; i++) {
                  const line = zone1Lines[i].trim();
                  const lineStart = originalText.indexOf(line, searchPos);
                  if (lineStart >= 0) {
                    searchPos = lineStart + line.length;
                  }
                }
                remainingForZone2 = originalText.substring(searchPos).trim();
              }
              
              if (remainingForZone2) {
                const zone2Lines = improvedSplitTextToSize(remainingForZone2, boxWidth - 10, doc);
                actualLinesRendered += zone2Lines.length;
              }
            } else {
              const allLines = improvedSplitTextToSize(originalText, boxWidth - 10, doc);
              actualLinesRendered = allLines.length;
            }
            
            // Recalculate precise box height based on actual rendered lines
            const headerSpace = 30;
            const actualTextHeight = actualLinesRendered * lineHeight;
            const precisePadding = 8;
            const recalculatedHeight = headerSpace + actualTextHeight + precisePadding;
            const finalBoxHeight = Math.max(baseHeight, recalculatedHeight);
            
            // Update the red box with correct height
            doc.setFillColor(255, 240, 240);
            doc.setDrawColor(0, 0, 0); // Black border for text boxes
            doc.setLineWidth(2);
            doc.roundedRect(boxX, boxY, boxWidth, finalBoxHeight, 8, 8, 'FD');
            
            // Add title inside red box
            doc.setFontSize(12);
            doc.setFont('helvetica', 'bold');
            const titleX = boxX + 10;
            const titleY = boxY + 15;
            
            // Render "ITEM " first
            doc.setTextColor(0, 0, 0);
            const itemPart2 = 'ITEM ';
            doc.text(itemPart2, titleX, titleY);
            const itemWidth2 = doc.getTextWidth(itemPart2);
            
            // Render red number immediately after
            doc.setTextColor(255, 0, 0);
            const numberPart2 = `${imageCounter}`;
            doc.text(numberPart2, titleX + itemWidth2, titleY);
            const numberWidth2 = doc.getTextWidth(numberPart2);
            
            // Render black period and rest of text
            doc.setTextColor(0, 0, 0);
            const restText = hasPinImage ? '. Notes & Location:' : '. Notes:';
            doc.text(restText, titleX + itemWidth2 + numberWidth2, titleY);
            
            // Red underline ONLY for "ITEM X" (exclude period) - consistent with continuation headers
            const underlineWidth2 = itemWidth2 + numberWidth2;
            doc.setLineWidth(0.5);
            doc.setDrawColor(0, 0, 0); // Black border for text boxes // Red color matching continuation headers
            doc.line(titleX, titleY + 2, titleX + underlineWidth2, titleY + 2);
            
            console.log(`[BoxSizing] Rendered ${actualLinesRendered} lines, box height: ${finalBoxHeight}px`);
            
            // Render text that fits in original box
            renderTextWithinPage(originalText, hasPinImage, doc, boxX, boxY, boxWidth, pinImageX, pinImageY, pinImageWidth, pinImageHeight);
            
            // NOW render pin image on top of red box and text (proper z-order)
            if (pinAreaImageData) {
              try {
                // Auto-detect image format from data URI
                let imageFormat = 'PNG'; // Default
                if (pinAreaImageData.startsWith('data:image/jpeg')) {
                  imageFormat = 'JPEG';
                } else if (pinAreaImageData.startsWith('data:image/png')) {
                  imageFormat = 'PNG';
                } else if (!pinAreaImageData.startsWith('data:image/')) {
                  console.warn('Pin image data is not in base64 format:', pinAreaImageData.substring(0, 50));
                }
                
                console.log(`[PIN FORMAT] Auto-detected format: ${imageFormat} from data URI header`);
                console.log(`[PIN POSITION] Rendering at (${pinImageX}, ${pinImageY}) with size ${pinImageWidth}x${pinImageHeight}`);
                console.log(`[PIN BOUNDS] Page dimensions: ${W}x${H}, pin right edge: ${pinImageX + pinImageWidth}, pin bottom edge: ${pinImageY + pinImageHeight}`);
                
                
                // Add enhanced blue border layer (3px larger on all sides) under the pinpoint map
                const borderWidth = pinImageWidth + 6; // Enhanced border (249 + 6 = 255)
                const borderHeight = pinImageHeight + 6; // Enhanced border (117 + 6 = 123)
                const borderX = pinImageX - 3; // 3px to the left for better visibility
                const borderY = pinImageY - 3; // 3px above for better visibility
                
                doc.setFillColor(59, 130, 246); // Modern blue color #3B82F6 (matches report ID styling)
                doc.rect(borderX, borderY, borderWidth, borderHeight, 'F'); // 'F' for filled rectangle
                console.log(`Added enhanced blue border: ${borderWidth}x${borderHeight} at (${borderX},${borderY})`);
                
                // Keep original pin image dimensions - DO NOT stretch to fit textbox height
                doc.addImage(pinAreaImageData, imageFormat, pinImageX, pinImageY, pinImageWidth, pinImageHeight);
                console.log(`✅ Successfully added pin area image ON TOP of red box: ${pinImageWidth}x${pinImageHeight} at (${pinImageX},${pinImageY}) as ${imageFormat}`);
              } catch (error) {
                console.error('❌ Failed to add pin area image:', error);
                console.log('Pin image data type:', typeof pinAreaImageData);
                console.log('Pin image data preview:', pinAreaImageData?.substring(0, 100));
              }
            } else {
              console.log('No pin area image data available for this item');
            }
          }
          
          // Create continuation page for overflow text
          if (continuationText) {
            createTextContinuationPage(continuationText, i + 1, false, doc); // Always use full-width text on continuation pages
          }
        } else if (hasPinImage) {
          // Handle items with pin attachments but no notes - render red box with "Location:" header
          console.log(`[PIN-ONLY] Item ${i+1} has pin but no notes - rendering location box`);
          
          // Use base height for pin items (120px minimum)
          const finalBoxHeight = 120;
          
          // Render red box with pin space
          doc.setFillColor(255, 240, 240);
          doc.setDrawColor(0, 0, 0); // Black border for text boxes
          doc.setLineWidth(2);
          doc.roundedRect(boxX, boxY, boxWidth, finalBoxHeight, 8, 8, 'FD');
          
          // Render header for location-only items
          doc.setFontSize(12);
          doc.setFont('helvetica', 'bold');
          const titleX = boxX + 10;
          const titleY = boxY + 20;
          
          // Render "ITEM " in black
          doc.setTextColor(0, 0, 0);
          doc.text('ITEM ', titleX, titleY);
          const itemWidth3 = doc.getTextWidth('ITEM ');
          
          // Render item number in red
          doc.setTextColor(220, 53, 69);
          const numberPart3 = `${i + 1}`;
          doc.text(numberPart3, titleX + itemWidth3, titleY);
          const numberWidth3 = doc.getTextWidth(numberPart3);
          
          // Render ". Location:" in black
          doc.setTextColor(0, 0, 0);
          doc.text('. Location:', titleX + itemWidth3 + numberWidth3, titleY);
          
          // Red underline for "ITEM N" (consistent with other headers)
          const underlineWidth3 = itemWidth3 + numberWidth3;
          doc.setLineWidth(0.5);
          doc.setDrawColor(0, 0, 0); // Black border for text boxes
          doc.line(titleX, titleY + 2, titleX + underlineWidth3, titleY + 2);
          
          // Render pin image in the red box
          if (pinAreaImageData) {
            try {
              let imageFormat = 'PNG';
              if (pinAreaImageData.startsWith('data:image/jpeg')) {
                imageFormat = 'JPEG';
              } else if (pinAreaImageData.startsWith('data:image/png')) {
                imageFormat = 'PNG';
              }
              
              const pinImageX = boxX + boxWidth - pinImageWidth - pinImageMargin - 0.5;
              const pinImageY = boxY + 1.5;
              
              // Add enhanced blue border layer (3px larger on all sides) under the pinpoint map
              const borderWidth = pinImageWidth + 6; // Enhanced border (249 + 6 = 255)
              const borderHeight = pinImageHeight + 6; // Enhanced border (117 + 6 = 123)
              const borderX = pinImageX - 3; // 3px to the left for better visibility
              const borderY = pinImageY - 3; // 3px above for better visibility
              
              doc.setFillColor(59, 130, 246); // Modern blue color #3B82F6 (matches report ID styling)
              doc.rect(borderX, borderY, borderWidth, borderHeight, 'F'); // 'F' for filled rectangle
              
              doc.addImage(pinAreaImageData, imageFormat, pinImageX, pinImageY, pinImageWidth, pinImageHeight);
              console.log(`[PIN-ONLY] Successfully rendered pin image for item ${i+1}`);
            } catch (error) {
              console.error(`[PIN-ONLY] Failed to render pin image for item ${i+1}:`, error);
            }
          }
        }
        
        // Enhanced text splitting that handles long character sequences better
        function improvedSplitTextToSize(text, maxWidth, pdfDoc) {
          // First try standard splitting
          const standardLines = pdfDoc.splitTextToSize(text, maxWidth);
          
          // Check if any lines are being broken too conservatively
          const improvedLines = [];
          standardLines.forEach(line => {
            // If line looks like it could fit more characters (very long sequences), try to optimize
            const lineWidth = pdfDoc.getTextWidth(line);
            if (lineWidth < maxWidth * 0.8 && line.length > 10) {
              // Try to fit more characters
              const words = line.split(' ');
              if (words.length === 1 && words[0].length > 15) {
                // Single very long word - try character-based breaking
                const chars = words[0];
                let optimizedLine = '';
                for (let i = 0; i < chars.length; i++) {
                  const testLine = optimizedLine + chars[i];
                  if (pdfDoc.getTextWidth(testLine) <= maxWidth * 0.95) {
                    optimizedLine = testLine;
                  } else {
                    if (optimizedLine) {
                      improvedLines.push(optimizedLine);
                      optimizedLine = chars[i];
                    }
                  }
                }
                if (optimizedLine) improvedLines.push(optimizedLine);
              } else {
                improvedLines.push(line);
              }
            } else {
              improvedLines.push(line);
            }
          });
          
          return improvedLines;
        }
        
        // Function to split text based on available space in current box
        function splitTextForAvailableSpace(text, hasPin, maxLines, boxWidth, pinImageWidth) {
          if (hasPin) {
            // Zone 1: 8 lines narrow, Zone 2: remaining full width
            const zone1MaxLines = Math.min(8, maxLines);
            const zone2MaxLines = maxLines - zone1MaxLines;
            
            // Calculate Zone 1 lines (narrow around pin) with improved word breaking
            const narrowWidth = boxWidth - pinImageWidth - 15;
            const zone1Lines = improvedSplitTextToSize(text, narrowWidth, doc);
            
            let originalLines = [];
            let remainingText = text;
            
            // Take up to zone1MaxLines for Zone 1
            const zone1Portion = zone1Lines.slice(0, zone1MaxLines);
            originalLines = [...zone1Portion];
            
            // Calculate remaining text after Zone 1
            if (zone1Portion.length > 0) {
              let searchPos = 0;
              for (let i = 0; i < zone1Portion.length; i++) {
                const line = zone1Portion[i].trim();
                const lineStart = text.indexOf(line, searchPos);
                if (lineStart >= 0) {
                  searchPos = lineStart + line.length;
                }
              }
              remainingText = text.substring(searchPos).trim();
            }
            
            // Zone 2: Full width for remaining text (if space available)
            if (remainingText && zone2MaxLines > 0) {
              const fullWidth = boxWidth - 10;
              const zone2Lines = improvedSplitTextToSize(remainingText, fullWidth, doc);
              const zone2Portion = zone2Lines.slice(0, zone2MaxLines);
              originalLines = [...originalLines, ...zone2Portion];
              
              // Calculate continuation text after Zone 2
              if (zone2Portion.length < zone2Lines.length) {
                let zone2SearchPos = 0;
                for (let i = 0; i < zone2Portion.length; i++) {
                  const line = zone2Portion[i].trim();
                  const lineStart = remainingText.indexOf(line, zone2SearchPos);
                  if (lineStart >= 0) {
                    zone2SearchPos = lineStart + line.length;
                  }
                }
                const continuationText = remainingText.substring(zone2SearchPos).trim();
                return {
                  originalText: originalLines.join(' ').trim(),
                  continuationText: continuationText
                };
              }
            } else if (remainingText) {
              // No space for Zone 2, all remaining text goes to continuation
              return {
                originalText: originalLines.join(' ').trim(),
                continuationText: remainingText
              };
            }
            
            return {
              originalText: originalLines.join(' ').trim(),
              continuationText: ''
            };
            
          } else {
            // No pin: Full width only
            const fullWidth = boxWidth - 10;
            const allLines = improvedSplitTextToSize(text, fullWidth, doc);
            
            if (allLines.length <= maxLines) {
              return {
                originalText: text,
                continuationText: ''
              };
            } else {
              const originalLines = allLines.slice(0, maxLines);
              const originalText = originalLines.join(' ').trim();
              
              // Find where original text ends in the source text
              const originalEnd = text.indexOf(originalText) + originalText.length;
              const continuationText = text.substring(originalEnd).trim();
              
              return {
                originalText: originalText,
                continuationText: continuationText
              };
            }
          }
        }
        
        // Function to estimate total text lines
        function estimateTextLines(text, hasPin) {
          if (hasPin) {
            // Zone 1: 8 lines narrow + Zone 2: remaining full width
            const narrowWidth = boxWidth - pinImageWidth - 15;
            const zone1Lines = doc.splitTextToSize(text, narrowWidth).slice(0, 8);
            
            // Calculate remaining text using same logic as renderTextWithinPage
            let remainingText = text;
            if (zone1Lines.length > 0) {
              let searchPos = 0;
              for (let i = 0; i < zone1Lines.length; i++) {
                const line = zone1Lines[i].trim();
                const lineStart = text.indexOf(line, searchPos);
                if (lineStart >= 0) {
                  searchPos = lineStart + line.length;
                }
              }
              remainingText = text.substring(searchPos).trim();
            }
            
            const fullWidthLines = remainingText ? doc.splitTextToSize(remainingText, boxWidth - 10) : [];
            return zone1Lines.length + fullWidthLines.length;
          } else {
            // Full width only
            return doc.splitTextToSize(text, boxWidth - 10).length;
          }
        }
        
        // Function to create text continuation page (text-only, no image duplication)
        function createTextContinuationPage(continuationText, itemNumber, hasPin, pdfDoc) {
          // Add new page for continuation text
          pdfDoc.addPage();
          
          // Set content opacity for confidential documents
          setContentOpacity(pdfDoc, isConfidential);
          
          // Add complete page header (consistent with main pages)
          addPageHeader(pdfDoc, `Report: ${reportNameEntry && reportNameEntry.label ? reportNameEntry.label : 'Unknown Report'}`);
          
          // Calculate precise text box height based on continuation text
          const boxX = 40, boxWidth = W - 80;
          let boxY = 95; // Below header
          
          // Calculate actual text lines and height
          const lineHeight = 12;
          let totalLines = 0;
          
          // Count ACTUAL rendered lines using SAME logic as text rendering (matches first page approach)
          let actualLinesRendered = 0;
          const fullWidth = boxWidth - 10;
          const actualLines = improvedSplitTextToSize(continuationText, fullWidth, pdfDoc);
          actualLinesRendered = actualLines.length;
          
          // Calculate precise box height using SAME logic as first page
          const headerSpace = 30; // Match first page exactly
          const actualTextHeight = actualLinesRendered * lineHeight;
          const precisePadding = 8; // Match first page exactly  
          const recalculatedHeight = headerSpace + actualTextHeight + precisePadding;
          const baseHeight = 60; // Minimum height for continuation pages
          const finalBoxHeight = Math.max(baseHeight, recalculatedHeight + 60); // Add 60px (5 lines) for better spacing on continuation pages
          
          console.log(`[CONT DEBUG] Dynamic box sizing: ${actualLinesRendered} actual lines × ${lineHeight}px = ${actualTextHeight}px text, header=${headerSpace}px, padding=${precisePadding}px, final=${finalBoxHeight}px`);
          
          // Create red box with dynamic sizing (SAME as first page)
          pdfDoc.setFillColor(255, 240, 240);
          pdfDoc.setDrawColor(0, 0, 0); // Black border for text boxes
          pdfDoc.setLineWidth(2);
          pdfDoc.roundedRect(boxX, boxY, boxWidth, finalBoxHeight, 8, 8, 'FD');
          
          // Add continuation header inside red box
          renderContinuationHeader(pdfDoc, boxX, boxY, itemNumber);
          
          // Render continuation text with full-width layout (no pin image on continuation pages)
          renderTextWithinPage(continuationText, false, pdfDoc, boxX, boxY, boxWidth, 
                               0, 0, 0, 0); // No pin image parameters needed for full-width
          
          // Add complete page footer
          const currentPageNum = pdfDoc.internal.getCurrentPageInfo().pageNumber;
          addPageFooter(pdfDoc, currentPageNum);
          
          // Add watermark to continuation page
          addConfidentialWatermark(pdfDoc, isConfidential, W, H);
        }
        
        // Function to render text within current page structure
        function renderTextWithinPage(text, hasPin, pdfDoc, bX, bY, bWidth, pX, pY, pWidth, pHeight) {
          // Standardize text formatting
          pdfDoc.setFontSize(11);
          pdfDoc.setFont('helvetica', 'normal');
          
          const lineHeight = 12;
          const textX = bX + 5;
          const startY = bY + 32; // Moved down by 2px to avoid pin image overlap
          
          if (hasPin) {
            // Two-zone system: Lines 1-8 narrow, 9+ full width
            const zone1MaxLines = 8;
            const narrowWidth = bWidth - pWidth - 15;
            const zone1Lines = improvedSplitTextToSize(text, narrowWidth, pdfDoc).slice(0, zone1MaxLines);
            
            // Calculate remaining text after Zone 1 - more accurate text consumption
            const zone1Text = zone1Lines.join(' ').trim();
            let remainingText = text;
            
            // Find where Zone 1 text ends in the original text
            if (zone1Text.length > 0) {
              // Use word-boundary matching to find the end of Zone 1 text
              let searchPos = 0;
              for (let i = 0; i < zone1Lines.length; i++) {
                const line = zone1Lines[i].trim();
                const lineStart = text.indexOf(line, searchPos);
                if (lineStart >= 0) {
                  searchPos = lineStart + line.length;
                }
              }
              remainingText = text.substring(searchPos).trim();
            }
            
            // Zone 2: Full width for remaining text
            const fullWidth = bWidth - 10;
            const zone2Lines = remainingText ? improvedSplitTextToSize(remainingText, fullWidth, pdfDoc) : [];
            
            // Render Zone 1 (narrow around pin)
            zone1Lines.forEach((line, index) => {
              pdfDoc.text(line, textX, startY + (index * lineHeight));
            });
            
            // Render Zone 2 (full width, seamless continuation)
            if (zone2Lines.length > 0) {
              const zone2StartY = startY + (zone1Lines.length * lineHeight);
              zone2Lines.forEach((line, index) => {
                pdfDoc.text(line, textX, zone2StartY + (index * lineHeight));
              });
            }
            
            console.log(`[TextFlow] Zone 1: ${zone1Lines.length} lines narrow, Zone 2: ${zone2Lines.length} lines full width`);
          } else {
            // No pin: Full width only
            const fullWidth = bWidth - 10;
            const allLines = improvedSplitTextToSize(text, fullWidth, pdfDoc);
            
            allLines.forEach((line, index) => {
              pdfDoc.text(line, textX, startY + (index * lineHeight));
            });
            
            console.log(`[TextFlow] Full width: ${allLines.length} lines`);
          }
        }
        
        // Function to render item header
        function renderItemHeader(pdfDoc, boxX, boxY, itemNumber) {
          pdfDoc.setFontSize(12);
          pdfDoc.setFont('helvetica', 'bold');
          const titleX = boxX + 10;
          const titleY = boxY + 15;
          
          pdfDoc.setTextColor(0, 0, 0);
          pdfDoc.text('ITEM ', titleX, titleY);
          const itemWidth = pdfDoc.getTextWidth('ITEM ');
          
          pdfDoc.setTextColor(220, 53, 69);
          const numberPart = `${itemNumber}`;
          pdfDoc.text(numberPart, titleX + itemWidth, titleY);
          const numberWidth = pdfDoc.getTextWidth(numberPart);
          
          pdfDoc.setTextColor(0, 0, 0);
          pdfDoc.text('. Notes & Location:', titleX + itemWidth + numberWidth, titleY);
          
          // Underline just "ITEM N" in red
          pdfDoc.setLineWidth(0.5);
          pdfDoc.setDrawColor(0, 0, 0); // Black border for text boxes // Red color
          pdfDoc.line(titleX, titleY + 2, titleX + itemWidth + numberWidth, titleY + 2);
          pdfDoc.setDrawColor(0, 0, 0); // Reset to black
        }
        
        // Function to render continuation header
        function renderContinuationHeader(pdfDoc, boxX, boxY, itemNumber) {
          pdfDoc.setFontSize(12);
          pdfDoc.setFont('helvetica', 'bold');
          const titleX = boxX + 10;
          const titleY = boxY + 15;
          
          pdfDoc.setTextColor(0, 0, 0);
          pdfDoc.text('ITEM ', titleX, titleY);
          const itemWidth = pdfDoc.getTextWidth('ITEM ');
          
          pdfDoc.setTextColor(220, 53, 69);
          const numberPart = `${itemNumber}`;
          pdfDoc.text(numberPart, titleX + itemWidth, titleY);
          const numberWidth = pdfDoc.getTextWidth(numberPart);
          
          pdfDoc.setTextColor(0, 0, 0);
          pdfDoc.text('. Notes Cont.:', titleX + itemWidth + numberWidth, titleY);
          
          // Underline just "ITEM N" in red
          pdfDoc.setLineWidth(0.5);
          pdfDoc.setDrawColor(0, 0, 0); // Black border for text boxes // Red color
          pdfDoc.line(titleX, titleY + 2, titleX + itemWidth + numberWidth, titleY + 2);
          pdfDoc.setDrawColor(0, 0, 0); // Reset to black
        }
        
        // Function to add page header
        function addPageHeader(pdfDoc, reportName) {
          const logoMargin = 21;
          const logoSize = 30;
          
          // Add logo
          if (headerLogoData) {
            try {
              pdfDoc.addImage(headerLogoData, "PNG", logoMargin, logoMargin, logoSize, logoSize);
            } catch(e) {
              console.warn('Header logo failed:', e);
              pdfDoc.setFontSize(12);
              pdfDoc.setFont('helvetica', 'bold');
              pdfDoc.text('JL', logoMargin, logoMargin + 15);
            }
          } else {
            pdfDoc.setFontSize(12);
            pdfDoc.setFont('helvetica', 'bold');
            pdfDoc.text('JL', logoMargin, logoMargin + 15);
          }
          
          // Centered header text
          const headerText = 'Johnson-Lancaster Commentated Operation Report';
          pdfDoc.setFontSize(11);
          pdfDoc.setFont('times', 'italic');
          const headerWidth = pdfDoc.getTextWidth(headerText);
          const centerX = (W - headerWidth) / 2;
          pdfDoc.text(headerText, centerX, 35);
          
          // Report name (top right)
          pdfDoc.setFontSize(9);
          pdfDoc.setFont('helvetica', 'normal');
          pdfDoc.text(reportName, W - 40, 55, {align: 'right'});
        }
        
        // Function to add page footer (totalPages will be calculated at end)
        function addPageFooter(pdfDoc, pageNumber) {
          pdfDoc.setFontSize(10);
          pdfDoc.setTextColor(150, 150, 150);
          pdfDoc.text('Internal - Confidentiality', 40, H-25);
          pdfDoc.text(`JOHNSON-LANCASTER AND ASSOCIATES, INC. - ${new Date().toLocaleDateString('en-US')} at ${new Date().toLocaleTimeString('en-US')}`, 40, H-10);
          // Page numbering will be updated at the end when we know total pages
          pdfDoc.text(`Page ${pageNumber}`, W-100, H-10);
          pdfDoc.setTextColor(0, 0, 0);
        }
      }
      
      // Footer for original page (always render even if continuation page exists)
      doc.setFontSize(10);
      doc.setTextColor(150, 150, 150);
      doc.text('Internal - Confidentiality', 40, H-25);
      doc.text(`JOHNSON-LANCASTER AND ASSOCIATES, INC. - ${new Date().toLocaleDateString('en-US')} at ${new Date().toLocaleTimeString('en-US')}`, 40, H-10);
      // Temporary page number - will be updated at end
      doc.text(`Page ${i + 2}`, W-100, H-10);
      doc.setTextColor(0, 0, 0);
      
      // Add watermark as final layer
      addConfidentialWatermark(doc, isConfidential, W, H);
      
      // Increment image counter (note: note cards increment in the conditional above)
      imageCounter++;
    }
    
    // ===== SIGNATURE PAGE =====
    if (signatureData) {
      doc.addPage();
      setContentOpacity(doc, isConfidential);
      
      // Header
      if (headerLogoData) {
        try {
          const smallLogoSize = 30;
          doc.addImage(headerLogoData, "PNG", 40, 15, smallLogoSize, smallLogoSize);
        } catch(e) {
          console.warn('Header logo failed:', e);
          doc.setFontSize(14);
          doc.setFont('helvetica', 'bold');
          doc.text('JL', 40, 40);
        }
      } else {
        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        doc.text('JL', 40, 40);
      }
      // Smaller, cursive, centered header text (consistent with regular pages)
      const headerText = 'Johnson-Lancaster Commentated Operation Report';
      doc.setFontSize(11);
      doc.setFont('times', 'italic');
      const headerWidth = doc.getTextWidth(headerText);
      const centerX = (W - headerWidth) / 2;
      doc.text(headerText, centerX, 35);
      
      // Add Report Name to header (smaller font, repositioned to avoid collision)
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.text(`Report: ${reportNameEntry && reportNameEntry.label ? reportNameEntry.label : 'Unknown Report'}`, W - 40, 55, {align: 'right'});
      
      // Signature title with underline
      doc.setFontSize(18);
      doc.setFont('helvetica', 'bold');
      const sigTitle = 'Authorized Signature';
      doc.text(sigTitle, W/2, 150, {align: 'center'});
      
      // Underline for signature title
      const sigTitleWidth = doc.getTextWidth(sigTitle);
      const sigTitleX = (W - sigTitleWidth) / 2;
      doc.setLineWidth(1);
      doc.line(sigTitleX, 155, sigTitleX + sigTitleWidth, 155);
      
      // Signature area
      try {
        const sigWidth = 400;
        const sigHeight = 200;
        const sigX = (W - sigWidth) / 2;
        const sigY = 170; // Moved closer to title (was 200, now 170)
        
        doc.addImage(signatureData, "PNG", sigX, sigY, sigWidth, sigHeight);
      } catch(e) {
        doc.setFontSize(12);
        doc.text("Signature could not be embedded", W/2, 300, {align: 'center'});
      }
      
      // Footer
      doc.setFontSize(10);
      doc.setTextColor(150, 150, 150);
      doc.text('Internal - Confidentiality', 40, H-25);
      doc.text(`JOHNSON-LANCASTER AND ASSOCIATES, INC. - ${new Date().toLocaleDateString('en-US')} at ${new Date().toLocaleTimeString('en-US')}`, 40, H-10);
      // Calculate total pages: 1 (title) + items + 1 (signature)
      const totalPagesWithSig = 1 + orderedItems.length + 1;
      const currentSigPage = totalPagesWithSig; // Signature is always the last page
      doc.text(`Page ${currentSigPage} of ${totalPagesWithSig}`, W-100, H-10);
      doc.setTextColor(0, 0, 0);
      
      // Add watermark as final layer
      addConfidentialWatermark(doc, isConfidential, W, H);
    }
    
    // Fix page numbering across all pages now that we know the total count
    const actualTotalPages = doc.internal.getNumberOfPages();
    console.log(`Fixing page numbers for ${actualTotalPages} total pages`);
    
    // Go through each page and update the page numbers
    for (let pageIndex = 1; pageIndex <= actualTotalPages; pageIndex++) {
      doc.setPage(pageIndex);
      
      // Find and replace page number text
      // Since we can't directly edit text, we'll overlay corrected page numbers
      doc.setFontSize(10);
      doc.setTextColor(150, 150, 150);
      
      // Cover existing page number area with white rectangle - make it larger to cover all possible text
      doc.setFillColor(255, 255, 255);
      doc.rect(W-160, H-18, 120, 15, 'F'); // Larger white rectangle to fully cover old page numbers
      
      // Add corrected page number
      doc.text(`Page ${pageIndex} of ${actualTotalPages}`, W-100, H-10);
      doc.setTextColor(0, 0, 0);
    }
    
    // Prepare filename for library storage (no auto-download)
    const cleanFilename = filename.replace(/\.pdf$/i, '') + '.pdf';
    
    // Capture PDF data for library storage (using both blob and data URLs for persistence)
    console.log(`Attempting to save PDF to library for job ID: ${jid}, filename: ${cleanFilename}`);
    try {
      const pdfBlob = doc.output('blob');
      console.log(`PDF blob created, size: ${pdfBlob.size} bytes`);
      
      // Create File object with proper filename for better browser compatibility
      const pdfFile = new File([pdfBlob], cleanFilename, { type: 'application/pdf' });
      const pdfBlobUrl = URL.createObjectURL(pdfFile);
      console.log(`PDF File URL created with filename: ${cleanFilename} -> ${pdfBlobUrl}`);
      
      // Also create data URL for persistence after page refresh
      const pdfDataUrl = doc.output('datauristring');
      console.log(`PDF data URL created, length: ${pdfDataUrl.length} characters`);
      
      // Debug PDF size issues
      console.log(`[PDF SIZE DEBUG] Final PDF blob: ${pdfBlob.size} bytes (${(pdfBlob.size/1024/1024).toFixed(2)}MB)`);
      console.log(`[PDF SIZE DEBUG] Final PDF dataURL: ${pdfDataUrl.length} characters (${(pdfDataUrl.length/1024/1024).toFixed(2)}MB)`);
      console.log(`[PDF SIZE DEBUG] Number of pages: ${doc.internal.getNumberOfPages()}`);
      console.log(`[PDF SIZE DEBUG] Items processed: ${orderedItems.length}`);
      
      // Save PDF metadata with both URLs for reliability
      // Use actual page count (includes continuation pages)
      const finalTotalPages = doc.internal.getNumberOfPages();
      await createPDFCard(jid, cleanFilename, pdfBlobUrl, pdfDataUrl, finalTotalPages, reportId, jobName);
      console.log(`PDF card created and saved to library for job ${jid}`);
    } catch(e) {
      console.error('Could not capture PDF for library:', e);
    }
    
    // Performance monitoring and cleanup
    const performanceEnd = performance.now();
    const durationMs = performanceEnd - pdfSession.performanceStart;
    const durationSeconds = (durationMs / 1000).toFixed(2);
    console.log(`PDF generation completed in ${durationSeconds} seconds (${Math.round(durationMs)}ms)`);
    console.log(`PDF generation finished at: ${new Date().toISOString()}`);
    
    // Clear timeout and release generation lock
    clearTimeout(pdfTimeout);
    isGeneratingPDF = false;
    console.log('PDF generation lock released');
    
    } // End of generatePDFWithLogos function
  }

  async function createPDFCard(jid, filename, pdfBlobUrl, pdfDataUrl, pageCount, reportId, jobName = null) {
    console.log(`createPDFCard called with jid: ${jid}, filename: ${filename}, pageCount: ${pageCount}, reportId: ${reportId}, jobName: ${jobName}`);
    const pdfId = generateJobId() + "-PDF";
    const pdfCard = {
      id: pdfId,
      reportId: jid,
      filename: filename,
      blobUrl: pdfBlobUrl,
      dataUrl: pdfDataUrl,
      createdAt: Date.now(),
      pageCount: pageCount,
      type: "pdf",
      jobName: jobName // Store the user-entered job name
    };
    
    console.log(`Created PDF card object:`, pdfCard);
    const pdfs = await loadPDFs();
    console.log(`Current PDFs in storage: ${pdfs.length}`);
    pdfs.push(pdfCard); // Add to end
    await savePDFs(pdfs);
    console.log(`Saved ${pdfs.length} PDFs to storage`);
    
    // Refresh UI to show new PDF card
    await renderPDFCards();
    console.log(`renderPDFCards called - PDF card should now be visible`);
    
    // Auto-open Floor Plans/Archivum modal to show the new PDF
    const floorplansOverlay = document.getElementById('floorplans-archivum-overlay');
    if (floorplansOverlay) {
      // Update job ID header
      const reportIdDisplay = document.getElementById('floorplans-report-id');
      const currentJobId = getCur();
      if (reportIdDisplay && currentJobId) {
        reportIdDisplay.innerHTML = `Working in Report ID: <strong>${currentJobId}</strong>`;
      }
      
      floorplansOverlay.removeAttribute('hidden');
      console.log('Auto-opened Floor Plans/Archivum modal to show new PDF');
    }
  }

  async function renderPDFCards(){
    console.log(`renderPDFCards called`);
    const pdfBucket = UI.pdfBucket || document.getElementById('pdf-bucket');
    if(!pdfBucket) {
      console.warn('PDF bucket not found in either location');
      return;
    }
    const currentJid = getCur();
    const allPDFs = await loadPDFs();
    console.log(`Current job ID: ${currentJid}, Total PDFs: ${allPDFs ? allPDFs.length : 'undefined'}`);
    
    // Filter PDFs for current Report ID
    const jobPDFs = allPDFs.filter(pdf => pdf.reportId === currentJid);
    console.log(`PDFs for job ${currentJid}: ${jobPDFs.length}`, jobPDFs);
    
    pdfBucket.innerHTML = "";
    
    if(jobPDFs.length === 0) {
      pdfBucket.innerHTML = "<div class='pdf-empty'>No PDF reports for this Report ID</div>";
      console.log('No PDFs found for current report, showing empty message');
      return;
    }
    
    jobPDFs.forEach(function(pdf){
      const pdfCard = document.createElement("div");
      pdfCard.className = "pdf-card";
      pdfCard.dataset.pdfId = pdf.id;
      
      pdfCard.innerHTML = `
        <div class="pdf-icon">📄</div>
        <div class="pdf-info">
          <div class="pdf-name" title="${pdf.filename}">${truncateFilename(pdf.filename)}</div>
          <div class="pdf-meta">${new Date(pdf.createdAt).toLocaleDateString()} • ${pdf.pageCount} pages • Report ID: ${pdf.reportId || 'N/A'}</div>
        </div>
        <button class="pdf-delete" title="Delete PDF">×</button>
      `;
      
      // Click to open PDF viewer
      pdfCard.addEventListener("click", function(e){
        if(e.target.classList.contains("pdf-delete")) return;
        openPDFViewer(pdf);
      });
      
      // Delete button
      pdfCard.querySelector(".pdf-delete").addEventListener("click", async function(e){
        e.stopPropagation();
        await deletePDFCard(pdf.id);
      });
      
      pdfBucket.appendChild(pdfCard);
    });
  }

  async function deletePDFCard(pdfId) {
    if(!confirm("Delete this PDF report?")) return;
    
    const pdfs = await loadPDFs();
    const filteredPDFs = pdfs.filter(pdf => pdf.id !== pdfId);
    await savePDFs(filteredPDFs);
    
    await renderPDFCards();
  }


  async function openPDFViewer(pdf) {
    
    // Create PDF viewer modal
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="pdf-viewer-container">
        <div class="pdf-viewer-header">
          <div class="pdf-viewer-title">📄 ${pdf.filename}</div>
          <div class="pdf-viewer-controls">
            <button id="pdf-sharepoint" class="btn btn-blue">Send to SharePoint</button>
            <button id="pdf-download" class="btn">Download</button>
            <button id="pdf-close" class="btn">Close</button>
          </div>
        </div>
        <div class="pdf-viewer-content">
          <div id="pdf-canvas-container">Loading PDF...</div>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Load and display PDF using iOS-aware method
    try {
      const pdfUrl = pdf.blobUrl || pdf.dataUrl;
      if (pdfUrl) {
        const isIOSDevice = /iPad|iPhone|iPod/i.test(navigator.userAgent);
        
        if (isIOSDevice && window.pdfjsLib) {
          // iOS: Use PDF.js canvas rendering to avoid iframe limitations
          console.log('[iOS PDF] Using PDF.js canvas rendering for iOS device');
          renderPDFWithPDFJS(pdfUrl, modal).catch(error => {
            console.error('[iOS PDF] Error in PDF.js rendering:', error);
            modal.querySelector('#pdf-canvas-container').innerHTML = 
              `<p style="text-align: center; padding: 20px; color: #e74c3c;">Error loading PDF preview on iOS. Use download button to view the file.</p>`;
          });
        } else {
          // Desktop: Use iframe (existing functionality)
          let objectUrl = pdfUrl;
          
          // If it's a data URL, convert to blob URL for better iframe support
          if (pdfUrl.startsWith('data:application/pdf')) {
            const byteCharacters = atob(pdfUrl.split(',')[1]);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
              byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], {type: 'application/pdf'});
            // Create File object with proper filename for better browser compatibility
            const file = new File([blob], pdf.filename || 'document.pdf', { type: 'application/pdf' });
            objectUrl = URL.createObjectURL(file);
          }
          
          // Create iframe with object URL and explicit height management
          const iframe = document.createElement('iframe');
        // Attempt to hide Chrome's download button with comprehensive URL parameters
        iframe.src = objectUrl + '#view=FitH&toolbar=0&navpanes=0&scrollbar=1&statusbar=0&messages=0';
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.minHeight = '600px'; // Force minimum height
        iframe.style.border = 'none';
        iframe.style.display = 'block';
        
        // Add CSS to hide download button if PDF.js is used
        iframe.onload = () => {
          try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
            if (iframeDoc) {
              const style = iframeDoc.createElement('style');
              style.textContent = `
                /* Hide Chrome PDF viewer download button */
                button[title*="Download"], 
                button[aria-label*="Download"],
                .download-button,
                [data-element-id="download"],
                #downloadButton,
                [title="Download"] {
                  display: none !important;
                }
                /* Keep other PDF viewer controls visible */
                .toolbar { display: flex !important; }
                button[title*="Print"], 
                button[title*="Zoom"],
                button[title*="Previous"],
                button[title*="Next"] {
                  display: inline-block !important;
                }
              `;
              iframeDoc.head.appendChild(style);
            }
          } catch (e) {
            console.log('Cannot inject CSS into PDF viewer (cross-origin restriction)');
            // Implement comprehensive download intercept fallback for Chrome's native PDF viewer
            setTimeout(() => {
              container.style.position = 'relative';
              
              // Create multiple intercept zones for different possible download button positions
              const interceptPositions = [
                { top: '8px', right: '45px', name: 'primary-download' },      // Main download button
                { top: '8px', right: '80px', name: 'secondary-download' },    // Alternative position
                { top: '12px', right: '50px', name: 'centered-download' },    // Centered variation
                { top: '8px', right: '15px', name: 'edge-download' }          // Right edge position
              ];
              
              interceptPositions.forEach((pos, index) => {
                const interceptor = document.createElement('div');
                interceptor.style.position = 'absolute';
                interceptor.style.top = pos.top;
                interceptor.style.right = pos.right;
                interceptor.style.width = '38px';  // Slightly larger coverage
                interceptor.style.height = '38px';
                interceptor.style.zIndex = '1001';
                interceptor.style.cursor = 'pointer';
                interceptor.style.backgroundColor = index === 0 ? 'rgba(255,0,0,0.1)' : 'rgba(0,255,0,0.1)'; // Debug colors
                interceptor.title = 'Download redirected to custom button';
                interceptor.setAttribute('data-intercept', pos.name);
                
                interceptor.addEventListener('click', (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  console.log(`Download intercepted at position: ${pos.name}`);
                  
                  // Trigger our custom download instead
                  const customDownloadBtn = modal.querySelector('#pdf-download');
                  if (customDownloadBtn) {
                    customDownloadBtn.click();
                  } else {
                    console.warn('Custom download button not found');
                  }
                  return false;
                });
                
                // Add visual feedback on hover
                interceptor.addEventListener('mouseenter', () => {
                  interceptor.style.backgroundColor = 'rgba(255,255,0,0.2)'; // Yellow highlight
                });
                
                interceptor.addEventListener('mouseleave', () => {
                  interceptor.style.backgroundColor = 'transparent';
                });
                
                container.appendChild(interceptor);
              });
              
              // Add full-width top bar intercept as final fallback
              const topBarIntercept = document.createElement('div');
              topBarIntercept.style.position = 'absolute';
              topBarIntercept.style.top = '0';
              topBarIntercept.style.right = '0';
              topBarIntercept.style.width = '120px';  // Cover entire right side of toolbar
              topBarIntercept.style.height = '48px';  // Toolbar height
              topBarIntercept.style.zIndex = '1000';  // Lower priority than specific overlays
              topBarIntercept.style.cursor = 'pointer';
              topBarIntercept.title = 'PDF toolbar area - use download button below';
              
              topBarIntercept.addEventListener('click', (e) => {
                // Only intercept if click is in the right portion (likely download area)
                const rect = topBarIntercept.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                if (clickX > 60) { // Right half of the toolbar
                  e.preventDefault();
                  e.stopPropagation();
                  console.log('Download intercepted via toolbar area');
                  
                  const customDownloadBtn = modal.querySelector('#pdf-download');
                  if (customDownloadBtn) {
                    customDownloadBtn.click();
                  }
                  return false;
                }
              });
              
              container.appendChild(topBarIntercept);
              
              // Hide debug overlays after testing period
              setTimeout(() => {
                document.querySelectorAll('[data-intercept]').forEach(el => {
                  el.style.backgroundColor = 'transparent';
                });
              }, 5000);
            }, 1000);
          }
        };
        
        const container = modal.querySelector('#pdf-canvas-container');
        container.style.height = '100%';
        container.style.minHeight = '600px';
        container.style.display = 'flex';
        container.innerHTML = '';
        container.appendChild(iframe);
        
        // Force iframe to use full available height after modal is visible
        setTimeout(() => {
          const modalContent = modal.querySelector('.pdf-viewer-content');
          if (modalContent) {
            const availableHeight = modalContent.clientHeight - 8; // Account for padding
            iframe.style.height = `${availableHeight}px`;
            container.style.height = `${availableHeight}px`;
            console.log(`Set PDF viewer height to: ${availableHeight}px`);
          }
        }, 100);
        
          // Clean up object URL when modal is closed
          modal.addEventListener('remove', () => {
            URL.revokeObjectURL(objectUrl);
          });
        }
      } else {
        // Fallback for other data formats
        modal.querySelector('#pdf-canvas-container').innerHTML = 
          `<p>PDF preview not available. Use download button to view the file.</p>`;
      }
    } catch(e) {
      console.error('Failed to load PDF viewer:', e);
      modal.querySelector('#pdf-canvas-container').innerHTML = 
        `<p>Error loading PDF preview. Use download button to view the file.</p>`;
    }
    
    // Event listeners
    modal.querySelector('#pdf-sharepoint').addEventListener('click', async () => {
      await uploadToSharePoint(pdf);
    });

    modal.querySelector('#pdf-download').addEventListener('click', () => {
      const link = document.createElement('a');
      link.href = pdf.blobUrl || pdf.dataUrl; // Use blob URL or fallback to data URL
      link.download = pdf.filename;
      link.click();
    });
    
    modal.querySelector('#pdf-close').addEventListener('click', () => {
      document.body.removeChild(modal);
    });
    
    // Close on backdrop click
    modal.addEventListener('click', (e) => {
      if(e.target === modal) {
        document.body.removeChild(modal);
      }
    });
  }

  // iOS PDF.js canvas rendering function
  async function renderPDFWithPDFJS(pdfUrl, modal) {
    const container = modal.querySelector('#pdf-canvas-container');
    container.innerHTML = '<div style="text-align: center; padding: 20px;">Loading PDF pages...</div>';
    
    try {
      // Get PDF data for PDF.js
      let pdfData;
      if (pdfUrl.startsWith('data:application/pdf')) {
        // Convert data URL to ArrayBuffer
        const byteCharacters = atob(pdfUrl.split(',')[1]);
        pdfData = new Uint8Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          pdfData[i] = byteCharacters.charCodeAt(i);
        }
      } else {
        // Fetch blob URL
        const response = await fetch(pdfUrl);
        pdfData = await response.arrayBuffer();
      }
      
      // Load PDF with PDF.js
      const pdf = await window.pdfjsLib.getDocument({ data: pdfData }).promise;
      console.log(`[iOS PDF] Loaded PDF with ${pdf.numPages} pages`);
      
      // Create scrollable container for all pages
      container.innerHTML = '';
      container.style.cssText = `
        height: 100%;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 10px;
        background: #f5f5f5;
        -webkit-overflow-scrolling: touch;
      `;
      
      // Render each page
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.2 }); // Good scale for mobile
        
        // Create canvas for this page
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.cssText = `
          display: block;
          margin: 0 auto 10px auto;
          border: 1px solid #ddd;
          border-radius: 4px;
          background: white;
          max-width: 100%;
          height: auto;
        `;
        
        // Render page to canvas
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;
        
        // Add page number label
        const pageLabel = document.createElement('div');
        pageLabel.textContent = `Page ${pageNum} of ${pdf.numPages}`;
        pageLabel.style.cssText = `
          text-align: center;
          margin-bottom: 5px;
          font-size: 12px;
          color: #666;
          font-weight: bold;
        `;
        
        container.appendChild(pageLabel);
        container.appendChild(canvas);
        
        console.log(`[iOS PDF] Rendered page ${pageNum}/${pdf.numPages}`);
      }
      
      console.log(`[iOS PDF] Successfully rendered all ${pdf.numPages} pages`);
      
    } catch (error) {
      console.error('[iOS PDF] Error rendering PDF with PDF.js:', error);
      container.innerHTML = `
        <div style="text-align: center; padding: 20px; color: #e74c3c;">
          <p>Error loading PDF preview on iOS.</p>
          <p>Please use the Download button to view the file.</p>
        </div>
      `;
    }
  }

  async function removeItem(jid, cardId){
    const arr = await loadItems(jid);
    const k = arr.findIndex(x => x.id === cardId);
    if(k >= 0){ arr.splice(k, 1); await saveItems(jid, arr); }
  }

  async function deleteJobName(nameId){
    // Remove name mapping
    try{ 
      localStorage.removeItem(nameKey(nameId));
      if (window.IndexedStorage && window.IndexedStorage.Storage) {
        window.IndexedStorage.Storage.removeItem(nameKey(nameId)).catch(console.warn);
      }
    }catch(_){}
    
    // Remove from names list
    const names = await loadNames();
    const k = names.findIndex(x => x.id === nameId);
    if(k >= 0) names.splice(k, 1);
    await saveNames(names);
    
    await renderUnifiedList();
  }

  async function deleteReportAndJobName(reportId){
    if(!confirm("Delete this Report and its Job Name? This will remove all associated cards, PDFs, and data.")) return;
    
    // Check if this is the current report BEFORE deletion
    const wasCurrentReport = getCur() === reportId;
    
    // First, find which job name this report ID belongs to
    const names = await loadNames();
    let associatedNameId = null;
    
    for (const nameEntry of names) {
      const attachedJobs = await loadNameMap(nameEntry.id) || [];
      if (attachedJobs.includes(reportId)) {
        associatedNameId = nameEntry.id;
        break;
      }
    }
    
    // Delete the report ID (calls existing deleteJobId logic)
    await deleteJobIdInternal(reportId);
    
    // Delete the associated job name if found
    if (associatedNameId) {
      await deleteJobName(associatedNameId);
    }
    
    // Handle current selection AFTER deletion
    if(wasCurrentReport) {
      const ids = await loadIds();
      if(ids.length > 0) {
        // Auto-select first remaining report
        setCur(ids[0].id);
        if(window.AppBoard && AppBoard.clearAndRenderFrom) await AppBoard.clearAndRenderFrom(ids[0].id);
        await renderCards();
        await renderPDFCards();
        await renderUnifiedList(); // Update UI immediately after auto-selection
        if(window.updateUIControlsState) await window.updateUIControlsState();
      } else {
        // Only clear current if no reports exist
        setCur(""); 
        document.getElementById("board").innerHTML = "";
        if(window.updateUIControlsState) await window.updateUIControlsState();
        
        // Clear Job Code input when no Report ID is selected
        const jobCodeInput = document.getElementById('job-code');
        if (jobCodeInput) {
          jobCodeInput.value = "";
        }
        
        // Clear Location input when no Report ID is selected
        const locationInput = document.getElementById('location-field');
        if (locationInput) {
          locationInput.value = "";
        }
        
        await renderCards();
        await renderPDFCards();
        await renderUnifiedList(); // Update UI when no reports remain
      }
    } else {
      await renderUnifiedList(); // Update UI for non-current report deletion
    }
  }

  async function deleteJobIdInternal(reportId){
    
    // Remove items
    try{ 
      localStorage.removeItem(itemsKey(reportId));
      if (window.IndexedStorage && window.IndexedStorage.Storage) {
        window.IndexedStorage.Storage.removeItem(itemsKey(reportId)).catch(console.warn);
      }
    }catch(_){}
    
    // Remove Job Code for this Report ID
    try{ 
      localStorage.removeItem(K_JOBCODE + reportId + "_v1");
      if (window.IndexedStorage && window.IndexedStorage.Storage) {
        window.IndexedStorage.Storage.removeItem(K_JOBCODE + reportId + "_v1").catch(console.warn);
      }
    }catch(_){}
    
    // Remove PDF reports for this Report ID
    const pdfs = await loadPDFs();
    const filteredPDFs = pdfs.filter(pdf => pdf.reportId !== reportId);
    await savePDFs(filteredPDFs);
    
    // Remove floor plans and pins for this Report ID
    console.log('About to delete floor plans for job:', reportId);
    if (window.FloorPlans && window.FloorPlans.handleJobDeletion) {
      console.log('Calling FloorPlans.handleJobDeletion');
      await window.FloorPlans.handleJobDeletion(reportId);
    } else {
      console.warn('FloorPlans system not available or handleJobDeletion missing');
      console.log('window.FloorPlans:', window.FloorPlans);
    }
    
    // Remove from ids list
    const ids = await loadIds();
    const k = ids.findIndex(x => x.id === reportId);
    if(k >= 0) ids.splice(k, 1);
    await saveIds(ids);
    
    // Detach from all names
    detachJobFromAll(reportId);
    
    // Note: Current ID handling moved to calling function for proper auto-selection
    
    // Re-render floor plan cards after job deletion
    if (window.FloorPlans && window.FloorPlans.renderFloorPlanCards) {
      await window.FloorPlans.renderFloorPlanCards();
    }
    
    // If we deleted the current Report ID, clear it and clear workspace
    const cur = getCur();
    if (cur === reportId) {
      setCur(""); // Clear current Report ID since it was deleted
      if (window.AppBoard) {
        await AppBoard.clearAndRenderFrom(""); // Clear workspace
      }
    } else if (cur && window.AppBoard) {
      await AppBoard.clearAndRenderFrom(cur);
    }
    
    // Clean up Job Names if no Report IDs remain
    const remainingIds = await loadIds();
    if (remainingIds.length === 0) {
      // Clear all Job Names when no Report IDs exist
      const names = await loadNames();
      names.forEach(name => {
        try{ 
          localStorage.removeItem(nameKey(name.id));
          if (window.IndexedStorage && window.IndexedStorage.Storage) {
            window.IndexedStorage.Storage.removeItem(nameKey(name.id)).catch(console.warn);
          }
        }catch(_){}
      });
      saveNames([]);
      console.log('Cleaned up all Job Names since no Report IDs remain');
    }
  }

  // Public function that maintains compatibility - now does cascading deletion
  async function deleteJobId(reportId){
    await deleteReportAndJobName(reportId);
  }

  // Initialize workspace (no modal needed)
  async function initializeWorkspace(){ 
    await renderUnifiedList(); 
    await renderCards(); 
    await renderPDFCards();
    updateStorageIndicator();
  }

  // Wire up Floor Plans button to open Floor Plans modal directly
  on(UI.btnFloorplans, "click", function() {
    const floorplansOverlay = document.getElementById('floorplans-archivum-overlay');
    if (floorplansOverlay) {
      // Update job ID header
      const reportIdDisplay = document.getElementById('floorplans-report-id');
      const currentJobId = getCur();
      if (reportIdDisplay && currentJobId) {
        reportIdDisplay.innerHTML = `Working in Report ID: <strong>${currentJobId}</strong>`;
      }
      
      floorplansOverlay.removeAttribute('hidden');
      
      // Initialize floor plans if needed
      if (window.FloorPlans && typeof window.FloorPlans.initializeFloorPlans === 'function') {
        window.FloorPlans.initializeFloorPlans();
      }
    }
  });

  // Initialize workspace on page load
  window.showLibrary = initializeWorkspace;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeWorkspace);
  } else {
    // DOM already loaded
    setTimeout(initializeWorkspace, 100);
  }

  on(UI.btnClearData, "click", async function(){
    const diagnostic = getStorageDiagnostic();
    
    const confirmMessage = `This will clear ALL stored data (${diagnostic.totalSizeMB}MB).\n\n` +
      `Items found:\n${diagnostic.items.slice(0, 5).map(item => `• ${item.key}: ${item.sizeMB}MB`).join('\n')}` +
      `${diagnostic.items.length > 5 ? `\n...and ${diagnostic.items.length - 5} more items` : ''}\n\n` +
      `${diagnostic.corruptedCount > 0 ? `⚠️ ${diagnostic.corruptedCount} corrupted items detected\n\n` : ''}` +
      `Are you sure you want to continue?`;
    
    if (confirm(confirmMessage)) {
      try {
        const result = await clearAllAppData();
        alert(`✅ Data cleared successfully!\n\nRemoved:\n• ${result.clearedLocalStorage} localStorage items\n• ${result.corruptedItemsRemoved} corrupted items\n• ${result.previousSize}MB total\n\nStorage should now show 0MB.`);
        
        // Refresh the UI
        await renderUnifiedList();
        await renderCards();
        await renderPDFCards();
        updateStorageIndicator();
        
        // Clear current report ID
        setCur("");
        
      } catch (error) {
        alert(`❌ Error clearing data: ${error.message}`);
        console.error('Clear data error:', error);
      }
    }
  });

  on(UI.btnCreate, "click", async function(){
    // Generate both job name and report ID
    const reportId = generateJobId();
    const nameId = "N" + generateJobId().slice(0, 8);
    const jobLabel = "New Report Name";
    
    // Create the job name
    const names = await loadNames();
    names.push({id: nameId, label: jobLabel, createdAt: Date.now()});
    await saveNames(names);
    
    // Create the report ID  
    const ids = await loadIds();
    ids.push({id: reportId, label: reportId, createdAt: Date.now()});
    await saveIds(ids);
    
    // Attach the report ID to the job name (create the pair)
    await attachJobToName(nameId, reportId);
    
    // Set as current and initialize
    setCur(reportId);
    await saveItems(reportId, []);
    await renderUnifiedList();
    await renderCards();
    await renderPDFCards();
    
    // Update UI controls after creating new report
    if(window.updateUIControlsState) await window.updateUIControlsState();
    
    // Clear Job Code input for new Report ID
    const jobCodeInput = document.getElementById('job-code');
    if (jobCodeInput) {
      jobCodeInput.value = "";
    }
    
    // Clear Location input for new Report ID
    const locationInput = document.getElementById('location-field');
    if (locationInput) {
      locationInput.value = "";
    }
    
    // Re-render floor plan cards when creating new Report ID
    if (window.FloorPlans && window.FloorPlans.renderFloorPlanCards) {
      await window.FloorPlans.renderFloorPlanCards();
    }
    
    if(window.AppBoard) await AppBoard.clearAndRenderFrom(reportId);
  });

  on(UI.btnExport, "click", exportPDF);
  
  // Save Job Code when it changes
  const jobCodeInput = document.getElementById('job-code');
  if (jobCodeInput) {
    jobCodeInput.addEventListener('input', async function() {
      const currentReportId = getCur();
      if (currentReportId) {
        await saveJobCode(currentReportId, jobCodeInput.value.trim());
      }
    });
  }

  // Save Location when it changes
  const locationInput = document.getElementById('location-field');
  if (locationInput) {
    locationInput.addEventListener('input', async function() {
      const currentReportId = getCur();
      if (currentReportId) {
        const locationValue = locationInput.value.trim();
        console.log('Saving location for report', currentReportId, ':', locationValue);
        await saveLocation(currentReportId, locationValue);
      }
    });
  }

  // Locate button functionality
  const locateBtn = document.getElementById('locate-btn');
  if (locateBtn) {
    locateBtn.addEventListener('click', async function() {
      if (!navigator.geolocation) {
        alert('Geolocation is not supported by this browser.');
        return;
      }

      // Check if we should use existing location or get fresh one
      const hasExistingLocation = locationInput.value && locationInput.value.trim() !== '';
      
      if (hasExistingLocation) {
        // User has existing location - ask if they want to update it
        const updateLocation = confirm('You have a saved location. Get current location instead?');
        if (!updateLocation) {
          return; // User wants to keep existing location
        }
      }

      locateBtn.textContent = '⏳ Getting location...';
      locateBtn.disabled = true;

      // Fast, single-attempt geolocation
      try {
        const position = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 5000  // Fast 5-second timeout
          });
        });
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const accuracy = position.coords.accuracy; // meters
        
        console.log(`GPS location: ${lat.toFixed(6)}, ${lng.toFixed(6)} (accuracy: ${Math.round(accuracy)}m)`);
        
        try {
          // Single geocoding call - no coordinate variations to reduce API calls
          const address = await reverseGeocodeEnhanced(lat, lng);
          
          // If accuracy is poor (>100m), show warning and allow manual editing
          if (accuracy > 100) {
            locationInput.value = `${address} (±${Math.round(accuracy)}m - please verify)`;
            alert(`⚠️ GPS accuracy is ${Math.round(accuracy)} meters. Please verify the address is correct and edit if needed.`);
          } else {
            locationInput.value = address;
          }
          
          // Save location automatically
          const currentReportId = getCur();
          if (currentReportId) {
            await saveLocation(currentReportId, locationInput.value);
          }
          
          console.log(`Location obtained:`, locationInput.value);
        } catch (error) {
          console.error('Failed to reverse geocode:', error);
          const coords = `${lat.toFixed(6)}, ${lng.toFixed(6)} (±${Math.round(accuracy)}m)`;
          locationInput.value = coords;
          
          // Save coordinates as fallback
          const currentReportId = getCur();
          if (currentReportId) {
            await saveLocation(currentReportId, coords);
          }
          alert('Could not find street address, saved coordinates instead. You can edit this manually.');
        }
        
        locateBtn.textContent = '📍 Locate';
        locateBtn.disabled = false;
      } catch (error) {
          console.log('Geolocation permission handled:', error.code === 1 ? 'Permission denied' : `Error ${error.code}`);
          
          let message;
          switch(error.code) {
            case 1: // PERMISSION_DENIED
              message = 'Location permission denied. Please enable location access in your browser settings.';
              break;
            case 2: // POSITION_UNAVAILABLE
              message = 'Your location is currently unavailable. Please try again.';
              break;
            case 3: // TIMEOUT
              message = 'Location request timed out. Please try again.';
              break;
            default:
              message = 'Unable to get your location. Please try again.';
          }
          
          alert(message + '\n\nYou can enter the address manually in the location field.');
          locateBtn.textContent = '📍 Locate';
          locateBtn.disabled = false;
        }
      });
  }


  window.addEventListener("load", async function(){
    const jid = await ensureCur(false); // Don't auto-create Report ID on page load
    console.log('Page load - Current Report ID:', jid || 'none');
    
    // Load job code for current Report ID if available
    if (jid) {
      const jobCodeInput = document.getElementById('job-code');
      if (jobCodeInput) {
        try {
          const jobCode = await loadJobCode(jid);
          jobCodeInput.value = jobCode;
        } catch (error) {
          console.warn('Failed to load job code on page load:', error);
        }
      }

      // Load location for current Report ID if available
      const locationInput = document.getElementById('location-field');
      if (locationInput) {
        try {
          const location = await loadLocation(jid);
          console.log('Loading location on page load for report', jid, ':', location);
          locationInput.value = location;
        } catch (error) {
          console.warn('Failed to load location on page load:', error);
        }
      }
    }
    
    // Initialize floor plan blob URL restoration and rendering on page load (after report ID is loaded)
    if (jid && window.FloorPlans) {
      try {
        // Now that we have a report ID, restore floor plan blob URLs
        if (typeof window.FloorPlans.restoreBlobUrls === 'function') {
          console.log('Restoring floor plan blob URLs with report ID:', jid);
          await window.FloorPlans.restoreBlobUrls();
        }
        
        if (typeof window.FloorPlans.renderFloorPlanCards === 'function') {
          await window.FloorPlans.renderFloorPlanCards();
          console.log('Floor plans rendered on page load');
        }
      } catch (error) {
        console.warn('Failed to render floor plans on page load:', error);
      }
    } else if (!jid) {
      console.log('No report ID available on page load - floor plans will load when report ID is selected');
      // Note: Floor plans will be rendered when user selects a report ID through the library interface
    }
    
    // Render PDF cards on page load
    try {
      await renderPDFCards();
      console.log('PDFs rendered on page load');
    } catch (error) {
      console.warn('Failed to render PDFs on page load:', error);
    }
    
    // One-time cleanup of legacy floor plans storage keys
    try {
      localStorage.removeItem("JL_floorplans_v1");
      localStorage.removeItem("JL_pins_v1");
      if (window.IndexedStorage && window.IndexedStorage.Storage) {
        window.IndexedStorage.Storage.removeItem("JL_floorplans_v1").catch(console.warn);
        window.IndexedStorage.Storage.removeItem("JL_pins_v1").catch(console.warn);
      }
      console.log('Cleaned up legacy floor plans storage');
    } catch(_) {}
    
    await renderUnifiedList();
    await renderCards();
    await renderPDFCards();
    if(window.AppBoard) await AppBoard.clearAndRenderFrom(jid);
    
    // Workspace drag simplified - no complex reordering needed
  });

  // Clean event isolation - only block workspace-interfering events
  (function(){
    var root = UI && UI.root;
    if (!root) return;
    
    // Only block events that would interfere with workspace, allow all drag events
    ["mousedown","mouseup","mousemove","touchstart","touchmove","touchend",
     "pointerdown","pointermove","pointerup","wheel"].forEach(function(t){
      root.addEventListener(t, function(e){ 
        // Only stop if clicking on the overlay background, not internal elements
        if(e.target === root) e.stopPropagation(); 
      }, true);
    });
  })();

  // Public API
  window.Library = {
    getCur: getCur, 
    ensureCurrent: ensureCur,
    loadItems: async function(j){ return await loadItems(j); },
    cleanupDragState: cleanupDragState,
    getStorageSize: getStorageSize,
    getStorageSizeMB: getStorageSizeMB,
    updateStorageIndicator: updateStorageIndicator,
    addItem: async function(jid, id, itemData){
      const items = await loadItems(jid);
      // Simple check - if ID already exists, don't add duplicate
      if(items.find(x => x.id === id)) return null;
      
      const newItem = Object.assign({id, reportId: jid}, itemData);
      items.push(newItem);
      await saveItems(jid, items);
      return newItem;
    },
    updateItem: async function(jid, id, patch){
      const items = await loadItems(jid);
      const index = items.findIndex(x => x.id === id);
      if(index >= 0) {
        items[index] = Object.assign(items[index], patch);
        await saveItems(jid, items);
        return items[index];
      }
      return null;
    },
    upsertItem: async function(jid, id, patch){
      const items = await loadItems(jid);
      const index = items.findIndex(x => x.id === id);
      
      if(index >= 0) {
        // Update existing item
        items[index] = Object.assign(items[index], patch || {});
        await saveItems(jid, items);
        return items[index];
      } else {
        // Add new item
        const newItem = Object.assign({id, reportId: jid}, patch || {});
        items.push(newItem);
        await saveItems(jid, items);
        return newItem;
      }
    },
    removeItem: removeItem,
    addWorkspaceDragToTile: addWorkspaceDragToTile,
    renderUnifiedList: renderUnifiedList,
    renderCards: renderCards,
    generatePDFLetter: generatePDFLetter,
    generateLibraryLetter: generateLibraryLetter
  };
  
  // Helper functions for Floor Plan integration
  
  /**
   * Find floor plan pins linked to a specific workspace item
   * @param {string} itemId - The workspace item ID
   * @returns {Promise<Array>} Promise that resolves to array of pins linked to this item
   */
  async function getFloorPlanPinsForItem(itemId) {
    if (!window.FloorPlans) return [];
    
    try {
      const pins = await window.FloorPlans.loadPins();
      
      // Add array validation to prevent pins.filter error
      if (!Array.isArray(pins)) {
        console.warn('Floor plan pins is not an array:', typeof pins, pins);
        return [];
      }
      
      return pins.filter(pin => pin.linkedCardId === itemId);
    } catch (error) {
      console.warn('Error loading floor plan pins:', error);
      return [];
    }
  }
  
  /**
   * Convert hex color to RGB values
   * @param {string} hex - Hex color string (e.g. "#3b82f6")
   * @returns {Object} RGB object with r, g, b properties
   */
  function hexToRgb(hex) {
    // Remove # if present
    hex = hex.replace('#', '');
    
    // Parse hex to RGB
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    
    return { r, g, b };
  }
  
  // Floor Plans/Archivum Modal Event Handlers - REMOVED (now handled by btn-floorplans)
  
  on(document.getElementById('floorplans-close'), 'click', function() {
    // Check if floor plan is currently uploading
    if (window.FloorPlans && window.FloorPlans.isUploadingFloorPlan) {
      alert('Please wait for the floor plan to finish uploading before closing.');
      return;
    }
    
    const floorplansOverlay = document.getElementById('floorplans-archivum-overlay');
    if (floorplansOverlay) {
      floorplansOverlay.setAttribute('hidden', '');
    }
  });
  
  // Helper functions for pin area image generation
  async function getFloorPlanForPin(pin) {
    if (!window.FloorPlans) return null;
    
    try {
      const floorPlans = await window.FloorPlans.loadFloorPlans();
      const floorPlanCard = floorPlans.find(fp => fp.id === pin.floorPlanCardId);
      if (floorPlanCard) {
        // Find the specific plan this pin belongs to
        const plan = floorPlanCard.plans.find(p => p.id === pin.planId);
        if (plan) {
          // Handle different image storage formats
          // Priority: blobUrl > getBlobUrl(blobId) > src
          if (plan.blobUrl) {
            return { ...plan, src: plan.blobUrl };
          } else if (plan.blobId && window.FloorPlans.getBlobUrl) {
            const blobUrl = window.FloorPlans.getBlobUrl(plan.blobId);
            if (blobUrl) {
              return { ...plan, src: blobUrl };
            }
          } else if (plan.src) {
            return plan;
          }
          console.warn('Plan found but no valid image source available:', plan.id);
        }
      }
    } catch (error) {
      console.warn('Error loading floor plan for pin:', error);
    }
    
    return null;
  }
  
  async function generatePinAreaImageAsync(pin, floorPlan) {
    console.log('generatePinAreaImageAsync called with:', { pinId: pin.id, floorPlanId: floorPlan.id, hasImageSrc: !!floorPlan.src });
    
    return new Promise((resolve, reject) => {
      try {
        const img = new Image();
        
        img.onload = function() {
          try {
            console.log('Image loaded successfully, dimensions:', img.width, 'x', img.height);
            
            // Create canvas for cropping
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            // Set crop dimensions - zoom out by ~5% for better context and decrease left width by 35px
            const cropWidth = Math.round(1106 * 1.05); // Zoom out 5% = ~1161px
            const cropHeight = Math.round(703 * 1.05);  // Zoom out 5% = ~738px
            
            // Final canvas size - increased resolution for crystal clear screenshots
            const dpr = Math.max(4, window.devicePixelRatio || 1); // Force at least 4x resolution for clarity
            canvas.width = 765 * dpr;  // Reduced width by 35px (800-35=765), then scaled by DPR
            canvas.height = 400 * dpr; // Keep height, scaled by DPR
            canvas.style.width = '765px';  // Reduced by 35px for text space
            canvas.style.height = '400px';
            
            // Scale context for ultra-high-DPI rendering
            ctx.scale(dpr, dpr);
            
            // Get image dimensions
            const imgWidth = img.naturalWidth || img.width;
            const imgHeight = img.naturalHeight || img.height;
            
            if (imgWidth && imgHeight) {
              // Calculate pin position in actual image coordinates
              const pinX = pin.x * imgWidth;
              const pinY = pin.y * imgHeight;
              
              // Calculate crop area (centered on pin, shifted left for text space)
              const cropX = pinX - cropWidth / 2 - 35; // Shift 35px left to make room for text
              const cropY = pinY - cropHeight / 2; // Center vertically
              
              // Ensure crop area is within image bounds
              const adjustedCropX = Math.max(0, Math.min(imgWidth - cropWidth, cropX));
              const adjustedCropY = Math.max(0, Math.min(imgHeight - cropHeight, cropY));
              
              // Enable highest quality image smoothing
              ctx.imageSmoothingEnabled = true;
              ctx.imageSmoothingQuality = 'high';
              
              // Fill with white background first (in case crop goes beyond image)
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, 765, 400);
              
              // Draw the cropped portion scaled to new canvas size (crystal clear)
              ctx.drawImage(
                img,
                adjustedCropX, adjustedCropY, cropWidth, cropHeight,
                0, 0, 765, 400  // New dimensions with 35px less width
              );
          
              // Draw the pin itself on the scaled image (account for new scaling)
              const pinCanvasX = (pinX - adjustedCropX) * (765 / cropWidth);
              const pinCanvasY = (pinY - adjustedCropY) * (400 / cropHeight);
              
              // Pin shaft (black line) - scaled up by 1.5x for larger pin with crisp rendering
              ctx.strokeStyle = '#000';
              ctx.lineWidth = 4; // 3 * 1.5 = 4.5, rounded to 4 (DPR scaling happens automatically)
              ctx.lineCap = 'round';
              ctx.beginPath();
              ctx.moveTo(pinCanvasX, pinCanvasY);
              ctx.lineTo(pinCanvasX, pinCanvasY - 37); // 25 * 1.5 = 37.5, rounded to 37
              ctx.stroke();
              
              // Pin head (colored circle) - scaled up by 1.5x for larger pin with crisp rendering
              ctx.fillStyle = pin.headColor;
              ctx.strokeStyle = '#000';
              ctx.lineWidth = 3; // 2 * 1.5 = 3 (DPR scaling happens automatically)
              ctx.beginPath();
              ctx.arc(pinCanvasX, pinCanvasY - 37, 15, 0, 2 * Math.PI); // 10 * 1.5 = 15, position matches shaft end
              ctx.fill();
              ctx.stroke();
              
              // Use high-quality JPEG for much smaller file size while maintaining clarity
              resolve(canvas.toDataURL('image/jpeg', 0.95));
            } else {
              console.warn('Could not get image dimensions');
              resolve(null);
            }
          } catch (error) {
            console.error('Error processing image:', error);
            resolve(null);
          }
        };
        
        img.onerror = function() {
          console.error('Failed to load image:', floorPlan.src.substring(0, 100) + '...');
          resolve(null);
        };
        
        // Set the source to trigger loading
        img.src = floorPlan.src;
        
      } catch (error) {
        console.error('Error in generatePinAreaImageAsync:', error);
        resolve(null);
      }
    });
  }
  
  // Global exports for integration with floor plans system
  window.library = {
    loadItems: loadItems,
    read: read,
    write: write,
    getStorageSizeMB: getStorageSizeMB,
    cleanupOldestItems: cleanupOldestItems,
    getCurrentReportId: getCur,
    setCurrentReportId: setCur,
    initCurrentReportIdCache: initCurrentReportIdCache
  };

  // Test if a blob URL is accessible (suppress expected console errors)
  async function testBlobUrlAccessible(blobUrl) {
    try {
      // Use Image object instead of fetch to avoid console errors for invalid blob URLs
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false); // Expected for invalid blob URLs
        img.src = blobUrl;
        // Timeout after 1 second to avoid hanging
        setTimeout(() => resolve(false), 1000);
      });
    } catch (error) {
      return false;
    }
  }

  // Restore PDF blob URLs for existing PDFs (similar to floor plans system)
  async function restorePDFBlobUrls() {
    try {
      const pdfs = await loadPDFs();
      let hasUpdates = false;
      let restoredCount = 0;
      let fallbackCount = 0;

      console.log(`Checking ${pdfs.length} PDFs for blob URL restoration...`);

      for (const pdf of pdfs) {
        // Check if PDF has data and needs blob URL restoration
        const hasDataUrl = pdf.dataUrl && pdf.dataUrl.length > 0;
        const hasBlobUrl = pdf.blobUrl && pdf.blobUrl.length > 0;
        
        if (!hasDataUrl && !hasBlobUrl) {
          console.warn('PDF has no data:', pdf.id, pdf.filename);
          continue;
        }

        // Force restoration of all PDF blob URLs after page refresh for reliability
        // Blob URLs become invalid after page refresh even if they exist in storage
        const needsRestoration = hasDataUrl;
        
        if (needsRestoration) {
          console.log('Restoring blob URL for PDF:', pdf.filename);
          
          try {
            // Convert data URL to blob URL for better performance
            if (pdf.dataUrl && pdf.dataUrl.startsWith('data:application/pdf')) {
              const byteCharacters = atob(pdf.dataUrl.split(',')[1]);
              const byteNumbers = new Array(byteCharacters.length);
              for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
              }
              const byteArray = new Uint8Array(byteNumbers);
              const blob = new Blob([byteArray], {type: 'application/pdf'});
              // Create File object with proper filename for better browser compatibility
              const file = new File([blob], pdf.filename || 'document.pdf', { type: 'application/pdf' });
              const blobUrl = URL.createObjectURL(file);
              
              pdf.blobUrl = blobUrl;
              hasUpdates = true;
              restoredCount++;
              console.log('Successfully restored blob URL for PDF:', pdf.filename);
            } else if (pdf.dataUrl) {
              // Fallback: use data URL directly if it's not a PDF data URL
              console.log('Using dataUrl as fallback for PDF:', pdf.filename);
              pdf.blobUrl = pdf.dataUrl;
              fallbackCount++;
              hasUpdates = true;
            }
          } catch (error) {
            console.warn('Failed to restore blob URL for PDF:', pdf.filename, error);
            // Use data URL as fallback
            if (pdf.dataUrl) {
              pdf.blobUrl = pdf.dataUrl;
              fallbackCount++;
              hasUpdates = true;
            }
          }
        }
      }

      // Save updates if any blob URLs were regenerated
      if (hasUpdates) {
        console.log(`Restored ${restoredCount} PDF blob URLs and ${fallbackCount} fallbacks, saving to IndexedDB`);
        await savePDFs(pdfs);
      } else {
        console.log('No PDF blob URLs needed restoration');
      }
    } catch (error) {
      console.error('Error during PDF blob URL restoration:', error);
    }
  }

  // Initialize IndexedDB and migrate data on load
  async function initializeIndexedDB() {
    try {
      console.log("Initializing IndexedDB...");
      await window.IndexedStorage.initDB();
      
      // Initialize current report ID cache
      await initCurrentReportIdCache();
      
      // Restore PDF blob URLs (PDFs aren't report-specific during initialization)
      await restorePDFBlobUrls();
      
      // Note: Floor plan blob URL restoration is handled after report ID is loaded in window load event
      
      console.log("IndexedDB initialization complete - using pure IndexedDB mode");
    } catch (error) {
      console.error("Failed to initialize IndexedDB:", error);
      throw new Error("IndexedDB is required for this application to function properly");
    }
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeIndexedDB);
  } else {
    initializeIndexedDB();
  }
  
  // Expose renderCards globally for app.js access
  window.renderCards = renderCards;
  
})();