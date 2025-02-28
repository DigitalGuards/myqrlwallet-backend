import { app } from './src/app.js';
import { CONFIG } from './src/config/index.js';

app.listen(CONFIG.PORT, () => {
  console.log(`Server running on port ${CONFIG.PORT}`);
});
