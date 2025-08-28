// JL Annotator Service Worker
// Cache-first strategy for static assets, network-first for API calls

const CACHE_NAME = 'jl-annotator-v1';
const STATIC_CACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/assets/styles.css',
  '/assets/bootstrap.js',
  '/assets/db.js', 
  '/assets/app.js',
  '/assets/library.js',
  '/assets/pdf-extraction.js',
  '/assets/floorplans.js',
  '/assets/favicon.ico',
  '/assets/jl-logo-header.png',
  '/assets/jl-logo-title.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Install event - cache static assets
self.addEventListener('install', event => {
  console.log('[SW] Installing service worker...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_CACHE_URLS);
      })
      .then(() => {
        console.log('[SW] Installation complete');
        return self.skipWaiting();
      })
      .catch(error => {
        console.error('[SW] Installation failed:', error);
      })
  );
});

// Activate event - cleanup old caches  
self.addEventListener('activate', event => {
  console.log('[SW] Activating service worker...');
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames.map(cacheName => {
            if (cacheName !== CACHE_NAME) {
              console.log('[SW] Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => {
        console.log('[SW] Activation complete');
        return self.clients.claim();
      })
  );
});

// Fetch event - cache strategy routing
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  
  // Skip caching for:
  // - POST/PUT requests (form submissions, uploads)
  // - API calls to external services
  // - Chrome extension requests
  if (request.method !== 'GET' || 
      url.protocol === 'chrome-extension:' ||
      url.hostname === 'nominatim.openstreetmap.org') {
    return;
  }
  
  // Handle API calls - network first with timeout
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      handleApiRequest(request)
    );
    return;
  }
  
  // Handle static assets - cache first
  event.respondWith(
    handleStaticRequest(request)
  );
});

// Network-first strategy for API calls with timeout
async function handleApiRequest(request) {
  try {
    // Try network first with 5 second timeout
    const networkPromise = fetch(request);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Network timeout')), 5000)
    );
    
    const response = await Promise.race([networkPromise, timeoutPromise]);
    
    if (response.ok) {
      return response;
    }
    throw new Error(`API request failed: ${response.status}`);
    
  } catch (error) {
    console.log('[SW] API request failed, no fallback available:', error);
    return new Response(
      JSON.stringify({ error: 'Network unavailable', offline: true }), 
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

// Cache-first strategy for static assets
async function handleStaticRequest(request) {
  try {
    // Check cache first
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(request);
    
    if (cachedResponse) {
      // Update cache in background if online
      if (navigator.onLine) {
        fetch(request)
          .then(response => {
            if (response.ok) {
              cache.put(request, response.clone());
            }
          })
          .catch(() => {
            // Silent fail for background updates
          });
      }
      
      return cachedResponse;
    }
    
    // Not in cache, try network
    const networkResponse = await fetch(request);
    
    if (networkResponse.ok) {
      // Cache successful responses
      cache.put(request, networkResponse.clone());
    }
    
    return networkResponse;
    
  } catch (error) {
    console.log('[SW] Static request failed:', error);
    
    // For HTML requests, serve offline page if available
    if (request.headers.get('accept')?.includes('text/html')) {
      const cache = await caches.open(CACHE_NAME);
      const offlineResponse = await cache.match('/index.html');
      if (offlineResponse) {
        return offlineResponse;
      }
    }
    
    // Generic network error response
    return new Response('Network unavailable', { 
      status: 503,
      statusText: 'Service Unavailable' 
    });
  }
}

// Background sync for offline operations (future enhancement)
self.addEventListener('sync', event => {
  if (event.tag === 'background-sync') {
    console.log('[SW] Background sync triggered');
    // Future: Handle offline form submissions
  }
});

// Push notifications (future enhancement)  
self.addEventListener('push', event => {
  if (event.data) {
    console.log('[SW] Push notification received:', event.data.text());
    // Future: Show notifications for report updates
  }
});