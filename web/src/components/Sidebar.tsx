import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { getJson } from "../lib/api";

interface AppLinks {
  githubUrl: string;
  icloudAlbumUrl: string;
  amazonAlbumUrl: string;
  amazonAlbumName: string;
}

export default function Sidebar() {
  const [links, setLinks] = useState<AppLinks | null>(null);

  useEffect(() => {
    let cancelled = false;

    getJson<AppLinks>("/api/links")
      .then((json) => {
        if (!cancelled) setLinks(json);
      })
      // Swallowed on purpose: the nav still has to render and navigate when the
      // links endpoint is unavailable.
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <aside className="sidebar">
      <h1>alexa-photos</h1>
      <nav>
        <NavLink to="/" end>
          Home
        </NavLink>
        <NavLink to="/amazon">Amazon Account</NavLink>
        <NavLink to="/mappings">Photo Mappings</NavLink>
      </nav>
      {/* Every link comes from the server, so the whole group goes away rather
          than leaving an empty "Links" heading behind. */}
      {links && (
        <div className="sidebar-footer">
          <span className="sidebar-footer-label">Links</span>
          {links.icloudAlbumUrl && (
            <a
              href={links.icloudAlbumUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              iCloud Album <span aria-hidden="true">↗</span>
            </a>
          )}
          {links.amazonAlbumUrl && (
            <a
              href={links.amazonAlbumUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={links.amazonAlbumName}
            >
              Amazon Album <span aria-hidden="true">↗</span>
            </a>
          )}
          {links.githubUrl && (
            <a href={links.githubUrl} target="_blank" rel="noopener noreferrer">
              GitHub <span aria-hidden="true">↗</span>
            </a>
          )}
        </div>
      )}
    </aside>
  );
}
