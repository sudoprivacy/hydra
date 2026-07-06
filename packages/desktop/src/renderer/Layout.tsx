// Shell layout: persistent nav + a content <Outlet/> the routed screens render
// into. Feature workers add nav entries / detail panes without owning this file.

import { Link, Outlet } from 'react-router-dom';

export function Layout(): JSX.Element {
  return (
    <div className="hydra-shell">
      <nav className="hydra-nav">
        <span className="hydra-brand">Hydra</span>
        <Link to="/mission-control">Mission Control</Link>
      </nav>
      <main className="hydra-content">
        <Outlet />
      </main>
    </div>
  );
}
