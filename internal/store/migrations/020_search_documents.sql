CREATE TABLE search_documents (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_seq INTEGER,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,

  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_search_documents_session ON search_documents(session_id, kind, event_seq);

CREATE VIRTUAL TABLE search_documents_fts USING fts5(
  title,
  content,
  content='search_documents',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3 4'
);

CREATE TRIGGER search_documents_ai AFTER INSERT ON search_documents BEGIN
  INSERT INTO search_documents_fts(rowid, title, content)
  VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER search_documents_ad AFTER DELETE ON search_documents BEGIN
  INSERT INTO search_documents_fts(search_documents_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
END;

CREATE TRIGGER search_documents_au AFTER UPDATE ON search_documents BEGIN
  INSERT INTO search_documents_fts(search_documents_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO search_documents_fts(rowid, title, content)
  VALUES (new.rowid, new.title, new.content);
END;

CREATE TABLE search_projection_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0
);

INSERT INTO search_projection_state(id, version) VALUES (1, 0);

INSERT INTO search_documents(key, kind, session_id, title, content, created_at)
SELECT 'session:' || id, 'session', id, COALESCE(title, ''), '', created_at
FROM sessions;

CREATE TRIGGER sessions_search_ai AFTER INSERT ON sessions BEGIN
  INSERT INTO search_documents(key, kind, session_id, title, content, created_at)
  VALUES ('session:' || new.id, 'session', new.id, COALESCE(new.title, ''), '', new.created_at);
END;

CREATE TRIGGER sessions_search_au AFTER UPDATE OF title ON sessions BEGIN
  UPDATE search_documents
  SET title = COALESCE(new.title, '')
  WHERE key = 'session:' || new.id;
END;
