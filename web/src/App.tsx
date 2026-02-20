import { Routes, Route, NavLink } from "react-router-dom";
import Mappings from "./pages/Mappings";
import Cookies from "./pages/Cookies";

export default function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <h1>alexa-photos</h1>
        <nav>
          <NavLink to="/" end>
            Photo Mappings
          </NavLink>
          <NavLink to="/cookies">Amazon Cookies</NavLink>
        </nav>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Mappings />} />
          <Route path="/cookies" element={<Cookies />} />
        </Routes>
      </main>
    </div>
  );
}
