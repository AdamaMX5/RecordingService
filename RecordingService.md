# RecordingService

Zeichnet Meeting-Räume auf, die vom LiveKit-Service verwaltet werden.

---

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/rooms` | Alle aktiven LiveKit-Räume auflisten |
| `GET` | `/rooms/:roomName/participants` | Alle Teilnehmer in einem Raum auflisten |
| `POST` | `/rooms/:roomName/record` | Aufzeichnung starten — Body `{ "participants": ["alice", "bob"] }` optional; weglassen für alle. Response: `202 { started, skipped }` |
| `DELETE` | `/rooms/:roomName/record` | Alle aktiven Aufzeichnungen in einem Raum stoppen |
| `GET` | `/rooms/:roomName/videos` | Alle Aufzeichnungen für einen Raum auflisten |
| `GET` | `/rooms/:roomName/videos/latest` | Neueste Aufzeichnung streamen / herunterladen |
| `GET` | `/rooms/:roomName/videos/:filename` | Bestimmte Aufzeichnung streamen / herunterladen |

> `?download=1` an jeden Video-Endpunkt anhängen, um einen Datei-Download zu erzwingen.
