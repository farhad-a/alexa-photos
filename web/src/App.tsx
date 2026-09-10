import { Routes, Route } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import Home from "./pages/Home";
import Mappings from "./pages/Mappings";
import Amazon from "./pages/Amazon";

export default function App() {
  return (
    <div className="app">
      <Sidebar />
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
