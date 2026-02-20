import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="card">
      <div className="page-header">
        <h2>Admin Home</h2>
      </div>

      <p className="home-subtitle">Choose a section to manage alexa-photos.</p>

      <div className="home-links">
        <Link className="home-link" to="/mappings">
          <h3>Photo Mappings</h3>
          <p>Browse, search, and delete iCloud ↔ Amazon mapping entries.</p>
        </Link>

        <Link className="home-link" to="/cookies">
          <h3>Amazon Cookies</h3>
          <p>View, update, and test Amazon authentication cookies.</p>
        </Link>
      </div>
    </div>
  );
}
