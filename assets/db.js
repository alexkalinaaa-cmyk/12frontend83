(function(){
  "use strict";
  
  // IndexedDB utility module for Job Library App
  const DB_NAME = "JobLibraryDB";
  const DB_VERSION = 2;
  
  // Object store names
  const STORES = {
    REPORT_IDS: "reportIds",
    REPORT_METADATA: "reportMetadata", 
    ITEMS: "items",
    FLOORPLANS: "floorplans",
    PDF_REPORTS: "pdfReports"
  };
  
  let db = null;
  
  // Initialize database
  function initDB() {
    return new Promise((resolve, reject) => {
      if (db) {
        resolve(db);
        return;
      }
      
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onerror = () => {
        console.error("Failed to open IndexedDB:", request.error);
        reject(request.error);
      };
      
      request.onsuccess = () => {
        db = request.result;
        console.log("IndexedDB opened successfully");
        resolve(db);
      };
      
      request.onupgradeneeded = (event) => {
        const database = event.target.result;
        console.log("Creating IndexedDB schema...");
        
        // Report IDs store - simple array storage
        if (!database.objectStoreNames.contains(STORES.REPORT_IDS)) {
          database.createObjectStore(STORES.REPORT_IDS, { keyPath: "key" });
        }
        
        // Report metadata store - names, job codes, current report
        if (!database.objectStoreNames.contains(STORES.REPORT_METADATA)) {
          const metadataStore = database.createObjectStore(STORES.REPORT_METADATA, { keyPath: "key" });
          metadataStore.createIndex("type", "type", { unique: false });
        }
        
        // Items store - annotation items per report ID
        if (!database.objectStoreNames.contains(STORES.ITEMS)) {
          const itemsStore = database.createObjectStore(STORES.ITEMS, { keyPath: "key" });
          itemsStore.createIndex("reportId", "reportId", { unique: false });
        }
        
        // Floor plans store - floor plan cards per report ID  
        if (!database.objectStoreNames.contains(STORES.FLOORPLANS)) {
          const floorplansStore = database.createObjectStore(STORES.FLOORPLANS, { keyPath: "key" });
          floorplansStore.createIndex("reportId", "reportId", { unique: false });
        }
        
        // PDF reports store - generated PDFs per report ID
        if (!database.objectStoreNames.contains(STORES.PDF_REPORTS)) {
          const pdfStore = database.createObjectStore(STORES.PDF_REPORTS, { keyPath: "key" });
          pdfStore.createIndex("reportId", "reportId", { unique: false });
        }
        
        console.log("IndexedDB schema created successfully");
      };
    });
  }
  
  // Generic get function
  async function dbGet(storeName, key) {
    const database = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([storeName], "readonly");
      const store = transaction.objectStore(storeName);
      const request = store.get(key);
      
      request.onsuccess = () => {
        resolve(request.result ? request.result.data : null);
      };
      
      request.onerror = () => {
        console.error(`Error getting ${key} from ${storeName}:`, request.error);
        reject(request.error);
      };
    });
  }
  
  // Generic set function
  async function dbSet(storeName, key, data) {
    const database = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([storeName], "readwrite");
      const store = transaction.objectStore(storeName);
      
      const record = { key, data };
      if (storeName === STORES.ITEMS) {
        record.reportId = key.split('_')[0]; // Extract report ID for indexing
      } else if (storeName === STORES.FLOORPLANS) {
        record.reportId = key.includes('_') ? key.split('_')[2] : null; // Extract from JL_floorplans_REPORTID format
      } else if (storeName === STORES.PDF_REPORTS) {
        record.reportId = key.split('_')[0]; // Extract report ID for indexing
      } else if (storeName === STORES.REPORT_METADATA) {
        record.type = key.startsWith('JL_report_names') ? 'names' : 
                     key.startsWith('JL_reportname_to') ? 'name_mapping' :
                     key.startsWith('JL_current_report') ? 'current' :
                     key.startsWith('JL_jobcode_') ? 'jobcode' : 'other';
      }
      
      const request = store.put(record);
      
      request.onsuccess = () => {
        resolve();
      };
      
      request.onerror = () => {
        console.error(`Error setting ${key} in ${storeName}:`, request.error);
        reject(request.error);
      };
    });
  }
  
  // Generic remove function
  async function dbRemove(storeName, key) {
    const database = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([storeName], "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);
      
      request.onsuccess = () => {
        resolve();
      };
      
      request.onerror = () => {
        console.error(`Error removing ${key} from ${storeName}:`, request.error);
        reject(request.error);
      };
    });
  }
  
  // Get all keys in a store
  async function dbGetAllKeys(storeName) {
    const database = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([storeName], "readonly");
      const store = transaction.objectStore(storeName);
      const request = store.getAllKeys();
      
      request.onsuccess = () => {
        resolve(request.result);
      };
      
      request.onerror = () => {
        console.error(`Error getting all keys from ${storeName}:`, request.error);
        reject(request.error);
      };
    });
  }
  
  // Clear all data from a store
  async function dbClear(storeName) {
    const database = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([storeName], "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.clear();
      
      request.onsuccess = () => {
        resolve();
      };
      
      request.onerror = () => {
        console.error(`Error clearing ${storeName}:`, request.error);
        reject(request.error);
      };
    });
  }
  
  // Get database size estimation
  async function dbGetSize() {
    const database = await initDB();
    let totalSize = 0;
    
    for (const storeName of Object.values(STORES)) {
      try {
        const transaction = database.transaction([storeName], "readonly");
        const store = transaction.objectStore(storeName);
        const request = store.getAll();
        
        await new Promise((resolve, reject) => {
          request.onsuccess = () => {
            const records = request.result;
            records.forEach(record => {
              totalSize += JSON.stringify(record.data).length;
            });
            resolve();
          };
          request.onerror = () => reject(request.error);
        });
      } catch (error) {
        console.warn(`Error calculating size for ${storeName}:`, error);
      }
    }
    
    return totalSize;
  }
  
  // Storage interface that mimics localStorage API
  const Storage = {
    async getItem(key) {
      try {
        // Determine which store to use based on key pattern
        let storeName;
        if (key === "JL_report_ids_v1") {
          storeName = STORES.REPORT_IDS;
        } else if (key.startsWith("JL_report_names") || key.startsWith("JL_reportname_to") || 
                   key.startsWith("JL_current_report") || key.startsWith("JL_jobcode_")) {
          storeName = STORES.REPORT_METADATA;
        } else if (key.startsWith("JL_items_by_report")) {
          storeName = STORES.ITEMS;
        } else if (key.startsWith("JL_floorplans_")) {
          storeName = STORES.FLOORPLANS;
        } else if (key.startsWith("JL_pdf_reports")) {
          storeName = STORES.PDF_REPORTS;
        } else {
          // Fallback to metadata store for unknown keys
          storeName = STORES.REPORT_METADATA;
        }
        
        const data = await dbGet(storeName, key);
        if (!data) return null;
        
        // Return data in the format expected by localStorage compatibility
        if (key.startsWith("JL_current_report") || key.startsWith("JL_signature_")) {
          // These keys should return raw string values
          return typeof data === 'string' ? data : String(data);
        } else {
          // These keys should return JSON strings
          return typeof data === 'string' ? data : JSON.stringify(data);
        }
      } catch (error) {
        console.error("Storage.getItem error:", error);
        return null;
      }
    },
    
    async setItem(key, value) {
      try {
        // Handle different data types - some keys store raw strings, others JSON
        let data;
        if (key.startsWith("JL_current_report") || key.startsWith("JL_signature_")) {
          // These keys store raw string values, not JSON
          data = value;
        } else {
          // These keys store JSON data
          try {
            data = JSON.parse(value);
          } catch (parseError) {
            // If JSON parsing fails, treat as raw string
            console.warn(`Key ${key} failed JSON parsing, storing as raw string:`, parseError);
            data = value;
          }
        }
        
        // Determine which store to use based on key pattern
        let storeName;
        if (key === "JL_report_ids_v1") {
          storeName = STORES.REPORT_IDS;
        } else if (key.startsWith("JL_report_names") || key.startsWith("JL_reportname_to") || 
                   key.startsWith("JL_current_report") || key.startsWith("JL_jobcode_")) {
          storeName = STORES.REPORT_METADATA;
        } else if (key.startsWith("JL_items_by_report")) {
          storeName = STORES.ITEMS;
        } else if (key.startsWith("JL_floorplans_")) {
          storeName = STORES.FLOORPLANS;
        } else if (key.startsWith("JL_pdf_reports")) {
          storeName = STORES.PDF_REPORTS;
        } else {
          // Fallback to metadata store for unknown keys
          storeName = STORES.REPORT_METADATA;
        }
        
        await dbSet(storeName, key, data);
      } catch (error) {
        console.error("Storage.setItem error:", error);
      }
    },
    
    async removeItem(key) {
      try {
        // Determine which store to use based on key pattern
        let storeName;
        if (key === "JL_report_ids_v1") {
          storeName = STORES.REPORT_IDS;
        } else if (key.startsWith("JL_report_names") || key.startsWith("JL_reportname_to") || 
                   key.startsWith("JL_current_report") || key.startsWith("JL_jobcode_")) {
          storeName = STORES.REPORT_METADATA;
        } else if (key.startsWith("JL_items_by_report")) {
          storeName = STORES.ITEMS;
        } else if (key.startsWith("JL_floorplans_")) {
          storeName = STORES.FLOORPLANS;
        } else if (key.startsWith("JL_pdf_reports")) {
          storeName = STORES.PDF_REPORTS;
        } else {
          // Fallback to metadata store for unknown keys
          storeName = STORES.REPORT_METADATA;
        }
        
        await dbRemove(storeName, key);
      } catch (error) {
        console.error("Storage.removeItem error:", error);
      }
    },
    
    async clear() {
      try {
        for (const storeName of Object.values(STORES)) {
          await dbClear(storeName);
        }
      } catch (error) {
        console.error("Storage.clear error:", error);
      }
    },
    
    async getSize() {
      return await dbGetSize();
    }
  };
  
  // Migration utility to transfer localStorage to IndexedDB
  async function migrateFromLocalStorage() {
    console.log("Starting localStorage to IndexedDB migration...");
    let migratedCount = 0;
    let errors = 0;
    
    try {
      await initDB();
      
      // Get all localStorage keys that match our patterns
      const keysToMigrate = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith("JL_") || key.includes("floorplans"))) {
          keysToMigrate.push(key);
        }
      }
      
      console.log(`Found ${keysToMigrate.length} keys to migrate`);
      
      // Migrate each key
      for (const key of keysToMigrate) {
        try {
          const value = localStorage.getItem(key);
          if (value) {
            await Storage.setItem(key, value);
            migratedCount++;
            console.log(`Migrated: ${key}`);
          }
        } catch (error) {
          console.error(`Error migrating ${key}:`, error);
          errors++;
        }
      }
      
      console.log(`Migration complete: ${migratedCount} keys migrated, ${errors} errors`);
      return { migratedCount, errors };
      
    } catch (error) {
      console.error("Migration failed:", error);
      throw error;
    }
  }
  
  // Export the API
  window.IndexedStorage = {
    Storage,
    initDB,
    migrateFromLocalStorage,
    STORES,
    DB_NAME,
    DB_VERSION
  };
  
})();