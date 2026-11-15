import { ViperConnectApp } from './app.js?v=4.0.42-d963f113';
const root = document.getElementById('app');
if (!root)
    throw new Error('ViperConnect app root not found');
const app = new ViperConnectApp(root);
void app.start();
