import { ViperConnectApp } from './app.js?v=4.0.35-a50438ad';
const root = document.getElementById('app');
if (!root)
    throw new Error('ViperConnect app root not found');
const app = new ViperConnectApp(root);
void app.start();
