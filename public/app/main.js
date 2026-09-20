import { ViperConnectApp } from './app.js?v=4.0.32-1ab9d8f1';
const root = document.getElementById('app');
if (!root)
    throw new Error('ViperConnect app root not found');
const app = new ViperConnectApp(root);
void app.start();
