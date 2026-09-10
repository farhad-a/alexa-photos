import { Routes, Route, NavLink } from "react-router-dom";
import Home from "./pages/Home";
import Mappings from "./pages/Mappings";
import Amazon from "./pages/Amazon";

export default function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <h1>alexa-photos</h1>
        <nav>
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/amazon">Amazon Account</NavLink>
          <NavLink to="/mappings">Photo Mappings</NavLink>
        </nav>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/amazon" element={<Amazon />} />
          <Route path="/mappings" element={<Mappings />} />
        </Routes>
      </main>
    </div>
  );
}
