/**
 * background-loader.js — Service Worker principal de BrowserMCP
 *
 * Point d'entrée du background déclaré dans manifest.json.
 * Importe le script enrichi execute-script-api.js qui contient
 * toute la logique WebSocket, les handlers MCP et le logger d'actions.
 *
 * Note : Chrome MV3 service workers utilisent importScripts() pour
 * charger des modules supplémentaires.
 */

// Importer le script API enrichi (connexion WS + tous les handlers)
importScripts('debugger-session.js', 'network-api.js', 'legacy-api.js', 'execute-script-api.js');
