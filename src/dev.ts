import { createApp } from "./app.js";
const port = Number(process.env.PORT ?? 3000);
createApp().listen(port, () => console.error(`gtm-mcp-server on http://localhost:${port}`));
