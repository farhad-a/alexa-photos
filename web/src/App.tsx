import { Routes, Route, NavLink } from "react-router-dom";
import Home from "./pages/Home";
import Mappings from "./pages/Mappings";
import Cookies from "./pages/Cookies";

export default function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <h1>alexa-photos</h1>
        <nav>
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/mappings">Photo Mappings</NavLink>
          <NavLink to="/cookies">Amazon Cookies</NavLink>
        </nav>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/mappings" element={<Mappings />} />
          <Route path="/cookies" element={<Cookies />} />
        </Routes>
      </main>
    </div>
  );
}
