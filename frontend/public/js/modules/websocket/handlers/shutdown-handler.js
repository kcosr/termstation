/**
 * Shutdown Message Handler
 * Handles WebSocket shutdown messages from the server
 * Shows loading overlay and polls both frontend and backend until ready
 */
import { debug } from '../../../utils/debug.js';
import { apiService } from '../../../services/api.service.js';

export class ShutdownHandler {
    constructor() {
        this.isShuttingDown = false;
        this.statusCheckInterval = null;
    }

    async handle(message, context) {
        debug.log('wsLogs', '[ShutdownHandler] Server shutdown notification received:', message);
        
        // Prevent multiple shutdown handling
        if (this.isShuttingDown) {
            debug.log('wsLogs', '[ShutdownHandler] Already handling shutdown, ignoring duplicate message');
            return;
        }
        
        this.isShuttingDown = true;
        
        // Disable WebSocket reconnection immediately to prevent multiple shutdown messages
        if (context.websocketService) {
            debug.log('wsLogs', '[ShutdownHandler] Disabling WebSocket reconnection');
            context.websocketService.options.reconnect = false;
            context.websocketService.isClosing = true;
            
            debug.log('wsLogs', '[ShutdownHandler] Closing WebSocket connection gracefully');
            context.websocketService.disconnect(1000, 'Server shutdown');
        }
        
        // Show the loading overlay
        this.showLoadingOverlay();
        
        // Start polling both frontend and backend
        this.startServicePolling(context);
    }
    
    showLoadingOverlay() {
        debug.log('wsLogs', '[ShutdownHandler] Showing loading overlay');
        const overlay = document.getElementById('shutdown-overlay');
        if (overlay) {
            overlay.classList.add('show');
            this.updateStatusMessage('Waiting for application to restart...');
        }
    }
    
    hideLoadingOverlay() {
        debug.log('wsLogs', '[ShutdownHandler] Hiding loading overlay');
        const overlay = document.getElementById('shutdown-overlay');
        if (overlay) {
            overlay.classList.remove('show');
        }
    }
    
    updateStatusMessage(message) {
        const statusElement = document.getElementById('shutdown-status');
        if (statusElement) {
            statusElement.textContent = message;
        }
    }
    
    async startServicePolling(context) {
        debug.log('wsLogs', '[ShutdownHandler] Starting service polling');
        let attempts = 0;
        
        // Get the API endpoint from the current config (already loaded)
        const { config } = await import('../../../core/config.js');
        const apiEndpoint = config.API_ENDPOINTS.INFO;
        debug.log('wsLogs', `[ShutdownHandler] Will check backend API: ${apiEndpoint}`);
        
        // Get frontend URL from appStore (stored when app loaded system info)
        const { appStore } = await import('../../../core/store.js');
        const systemInfo = appStore.getState('systemInfo');
        const frontendBaseUrl = systemInfo?.frontend_url || window.location.origin + window.location.pathname.replace(/\/$/, '');
        const frontendHealthUrl = frontendBaseUrl; // Check the index page directly
        debug.log('wsLogs', `[ShutdownHandler] Will check frontend health at: ${frontendHealthUrl}`);
        
        this.statusCheckInterval = setInterval(async () => {
            attempts++;
            debug.log('wsLogs', `[ShutdownHandler] Service check attempt ${attempts}`);
            this.updateStatusMessage(`Checking services... (attempt ${attempts})`);
            
            let frontendOk = false;
            let backendOk = false;
            
            // Check frontend by trying to fetch the index page
            try {
                const frontendResponse = await fetch(frontendHealthUrl, {
                    method: 'HEAD',
                    credentials: 'same-origin',
                    cache: 'no-cache', // Prevent cached responses
                    signal: AbortSignal.timeout(2000)
                });
                frontendOk = frontendResponse.ok;
            } catch (error) {
                // Frontend is down - continue polling
                frontendOk = false;
            }
            
            // Check backend API using API service (respects auth and nginx prefix)
            try {
                await apiService.getInfo();
                backendOk = true;
            } catch (error) {
                // Treat 401 Unauthorized as backend reachable (auth required)
                if (error && (error.status === 401)) {
                    backendOk = true;
                } else {
                    backendOk = false;
                }
            }
            
            // Update status message based on what's ready
            if (frontendOk && backendOk) {
                debug.log('wsLogs', '[ShutdownHandler] Both services are back online! Reloading page...');
                this.updateStatusMessage('Services online! Reloading...');
                
                clearInterval(this.statusCheckInterval);
                this.statusCheckInterval = null;
                
                setTimeout(() => {
                    debug.log('wsLogs', '[ShutdownHandler] Executing page reload...');
                    try {
                        const isDesktop = !!(window.desktop && window.desktop.isElectron);
                        if (isDesktop) {
                            try { window.desktop?.reloadWindow?.(); } catch (_) { /* ignore */ }
                        } else {
                            window.location.reload();
                        }
                    } catch (_) {
                        try { window.location.reload(); } catch (_) {}
                    }
                }, 500);
                return;
            } else {
                this.updateStatusMessage(`Waiting for application... (attempt ${attempts})`);
            }
            
            // Timeout fallback
            if (attempts >= 120) {
                console.warn('[ShutdownHandler] Service polling timeout - falling back to page reload');
                this.updateStatusMessage('Timeout reached. Reloading page...');
                setTimeout(() => {
                    debug.log('wsLogs', '[ShutdownHandler] Timeout reached - executing fallback reload');
                    try {
                        const isDesktop = !!(window.desktop && window.desktop.isElectron);
                        if (isDesktop) {
                            try { window.desktop?.reloadWindow?.(); } catch (_) { /* ignore */ }
                        } else {
                            window.location.reload();
                        }
                    } catch (_) {
                        try { window.location.reload(); } catch (_) {}
                    }
                }, 1000);
                clearInterval(this.statusCheckInterval);
                this.statusCheckInterval = null;
            }
        }, 1000);
    }
    
    // Method to cancel shutdown handling (in case needed)
    cancel() {
        debug.log('wsLogs', '[ShutdownHandler] Canceling shutdown handling');
        if (this.statusCheckInterval) {
            clearInterval(this.statusCheckInterval);
            this.statusCheckInterval = null;
        }
        this.hideLoadingOverlay();
        this.isShuttingDown = false;
    }
}

export const shutdownHandler = new ShutdownHandler();
