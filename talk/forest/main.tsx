// The Forrest slide's demo: a Claude artifact (magical-forest-game.tsx, kept as it came) mounted on
// a page of its own. Pre-bundled into public/talk/forest/ so neither the talk nor the game's build
// has to know about React — rebuild with `npm run build:forest` after editing either file.
import { createRoot } from 'react-dom/client';
import MagicalForestGame from './magical-forest-game';

createRoot(document.getElementById('root')!).render(<MagicalForestGame />);
