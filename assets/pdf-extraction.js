/**
 * PDF Floor Plan Extraction Engine
 * Extracts actual floor plan images from PDF pages using heuristics
 */

(function(){
  "use strict";
  
  // Floor Plan Detection Configuration
  const EXTRACTION_CONFIG = {
    // Minimum dimensions for a valid floor plan (pixels)
    MIN_WIDTH: 200,
    MIN_HEIGHT: 200,
    
    // Maximum logo/legend size to exclude (as fraction of page)
    MAX_LOGO_SIZE: 0.15,
    
    // Line density thresholds for floor plan detection
    MIN_LINE_DENSITY: 0.02,  // Minimum line pixels per total pixels
    
    // Aspect ratio constraints (width/height)
    MIN_ASPECT_RATIO: 0.3,   // Avoid very tall/thin images
    MAX_ASPECT_RATIO: 4.0,   // Avoid very wide images
    
    // Edge detection thresholds
    EDGE_THRESHOLD: 100,     // Minimum edge strength
    
    // Canvas rendering settings - optimized for quality
    RENDER_SCALE: 2.0,       // High quality floor plans while keeping file size reasonable
    MAX_CANVAS_SIZE: 6000    // Allow larger native dimensions
  };
  
  /**
   * Extract all pages from a PDF file as floor plans
   * @param {File} file - PDF file to process
   * @param {Function} progressCallback - Called with progress updates
   * @returns {Promise<Array>} Array of floor plans (one per page)
   */
  async function extractFloorPlansFromPDF(file, progressCallback = () => {}) {
    try {
      progressCallback({ stage: 'loading', progress: 0, message: 'Loading PDF...' });
      
      // Load PDF
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      
      progressCallback({ stage: 'parsing', progress: 10, message: `Loaded PDF with ${pdf.numPages} pages` });
      
      const floorPlans = [];
      
      // Process each page as a separate floor plan
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        progressCallback({ 
          stage: 'extracting', 
          progress: 10 + (pageNum / pdf.numPages) * 80, 
          message: `Extracting page ${pageNum} of ${pdf.numPages}...` 
        });
        
        const page = await pdf.getPage(pageNum);
        const floorPlan = await renderPageAsFloorPlan(page, pageNum - 1);
        floorPlans.push(floorPlan);
      }
      
      progressCallback({ stage: 'complete', progress: 100, message: `Extracted ${floorPlans.length} floor plans` });
      
      return floorPlans;
      
    } catch (error) {
      console.error('Error extracting floor plans:', error);
      progressCallback({ stage: 'error', progress: 0, message: `Error: ${error.message}` });
      throw error;
    }
  }
  
  /**
   * Render a PDF page as a floor plan
   * @param {PDFPageProxy} page - PDF.js page object
   * @param {number} pageIndex - 0-based page index
   * @returns {Promise<Object>} Floor plan object
   */
  async function renderPageAsFloorPlan(page, pageIndex) {
    const viewport = page.getViewport({ scale: 1.0 });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    
    // Set up canvas with appropriate scale
    const scale = Math.min(
      EXTRACTION_CONFIG.RENDER_SCALE,
      EXTRACTION_CONFIG.MAX_CANVAS_SIZE / Math.max(viewport.width, viewport.height)
    );
    
    canvas.width = viewport.width * scale;
    canvas.height = viewport.height * scale;
    
    const renderContext = {
      canvasContext: context,
      viewport: page.getViewport({ scale: scale })
    };
    
    // Optimize canvas context for crisp rendering
    context.imageSmoothingEnabled = false;  // Pixel-perfect for line drawings
    
    // Render page to canvas
    await page.render(renderContext).promise;
    
    // Return floor plan object
    return {
      id: `page-${pageIndex}`,
      pageIndex: pageIndex,
      sourceRect: { x: 0, y: 0, width: viewport.width, height: viewport.height },
      src: canvas.toDataURL('image/png'),
      width: canvas.width,
      height: canvas.height,
      name: `Page ${pageIndex + 1}`,
      extractionMethod: 'full-page'
    };
  }
  
  /**
   * Extract a 125x110px area around a pin location
   * @param {Object} pin - Pin object with x,y coordinates (0-1 normalized)
   * @param {Object} floorPlan - Floor plan object with image source
   * @returns {Promise<string>} Base64 image data of cropped area
   */
  async function extractPinArea(pin, floorPlan) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = function() {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        // Set crop dimensions - optimized for clear map visibility
        const cropWidth = 600;  // 1.4x increase for better detail
        const cropHeight = 560;
        
        canvas.width = cropWidth;
        canvas.height = cropHeight;
        
        // Calculate pin position in actual image coordinates
        const pinX = pin.x * img.width;
        const pinY = pin.y * img.height;
        
        // Calculate crop area (centered on pin)
        const cropX = pinX - cropWidth / 2;
        const cropY = pinY - cropHeight / 2;
        
        // Ensure crop area is within image bounds
        const adjustedCropX = Math.max(0, Math.min(img.width - cropWidth, cropX));
        const adjustedCropY = Math.max(0, Math.min(img.height - cropHeight, cropY));
        
        // Optimize canvas for sharp rendering
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        
        // Fill with white background first (in case crop goes beyond image)
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cropWidth, cropHeight);
        
        // Draw the cropped portion with high quality
        ctx.drawImage(
          img,
          adjustedCropX, adjustedCropY, cropWidth, cropHeight,
          0, 0, cropWidth, cropHeight
        );
        
        // Draw the pin itself on the cropped image
        const pinCanvasX = pinX - adjustedCropX;
        const pinCanvasY = pinY - adjustedCropY;
        
        // Pin shaft (black line) - 1.2x larger, original position
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 4;  // 3 * 1.2 = 3.6, rounded to 4
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(pinCanvasX, pinCanvasY);      // Original position
        ctx.lineTo(pinCanvasX, pinCanvasY - 24); // 24px shaft length (20 * 1.2)
        ctx.stroke();
        
        // Pin head (colored circle) - 1.2x larger
        ctx.fillStyle = pin.headColor;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2.4;  // 2 * 1.2
        ctx.beginPath();
        ctx.arc(pinCanvasX, pinCanvasY - 24, 10, 0, 2 * Math.PI);  // r=10 (8*1.2), original position
        ctx.fill();
        ctx.stroke();
        
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = reject;
      img.src = floorPlan.src;
    });
  }
  
  // Export functions
  window.PDFExtraction = {
    extractFloorPlansFromPDF,
    extractPinArea,
    EXTRACTION_CONFIG
  };
  
})();