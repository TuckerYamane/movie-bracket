const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const defaultMovies = [
  { id: 1, title: 'Oppenheimer', rating: 'R', stars: 8.5, poster: 'https://image.tmdb.org/t/p/w342/8Gxv8gSZDMIA_Pe0ZwTTP0MwMUc.jpg' },
  { id: 2, title: 'Dune: Part Two', rating: 'PG-13', stars: 8.3, poster: 'https://image.tmdb.org/t/p/w342/eu0QSqL305wcsZ3K23nLmwuZcD8.jpg' },
  { id: 3, title: 'Barbie', rating: 'PG-13', stars: 7.9, poster: 'https://image.tmdb.org/t/p/w342/iJeGLCUvNGY5OvPrtCKfkqJllVT.jpg' },
  { id: 4, title: 'Inside Out 2', rating: 'G', stars: 8.2, poster: 'https://image.tmdb.org/t/p/w342/vpnVM8EKipMKPKF0F4G0o9PJ7Zb.jpg' },
  { id: 5, title: 'Killers of the Flower Moon', rating: 'R', stars: 8.0, poster: 'https://image.tmdb.org/t/p/w342/dB6Krk806DuKvIIiF5pCKSuoEKW.jpg' },
  { id: 6, title: 'The Brutalist', rating: 'R', stars: 8.1, poster: 'https://image.tmdb.org/t/p/w342/aMnHoceqy5OzPpnKhZhxBqlGSJC.jpg' },
  { id: 7, title: 'The Zone of Interest', rating: 'R', stars: 7.7, poster: 'https://image.tmdb.org/t/p/w342/5ZlC5VqLlH91iO0S2ZL9nVtdxfE.jpg' },
  { id: 8, title: 'Poor Things', rating: 'R', stars: 7.5, poster: 'https://image.tmdb.org/t/p/w342/gWbktsosS3Yky4xMM2C2mKpKsY1.jpg' }
];

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function createRoom() {
  const code = generateRoomCode();
  rooms[code] = { code, players: {}, phase: 'lobby', movies: [...defaultMovies], selectedMovies: [], bracket: null, currentRound: 0, currentMatch: 0, votes: {}, voteHistory: [] };
  return code;
}

function createBracket(movies) {
  const rounds = [];
  const matches = [];
  for (let i = 0; i < movies.length; i += 2) {
    matches.push({ id: matches.length, m1: movies[i], m2: i + 1 < movies.length ? movies[i + 1] : null, w: null });
  }
  rounds.push([...matches]);
  let current = matches;
  while (current.length > 1) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) next.push({ id: next.length, m1: null, m2: null, w: null });
    rounds.push([...next]);
    current = next;
  }
  return rounds;
}

io.on('connection', (socket) => {
  socket.on('create-room', (callback) => {
    const code = createRoom();
    socket.join(code);
    rooms[code].hostId = socket.id;
    callback({ code });
  });

  socket.on('join-room', (data, callback) => {
    const { code, name, avatar } = data;
    const room = rooms[code.toUpperCase()];
    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }
    socket.join(code.toUpperCase());
    room.players[socket.id] = { name, avatar, votes: [] };
    io.to(code.toUpperCase()).emit('update-players', {
      players: Object.entries(room.players).map(([id, p]) => ({ id, ...p })),
      phase: room.phase
    });
    callback({ success: true, code: code.toUpperCase() });
  });

  socket.on('start-selection', (code) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    room.phase = 'selection';
    room.selectedMovies = [];
    io.to(code).emit('phase-change', { phase: 'selection', timeLimit: 180, movies: room.movies });
  });

  socket.on('select-movie', (data) => {
    const { code, movieId } = data;
    const room = rooms[code];
    if (!room) return;
    const movie = room.movies.find(m => m.id === movieId);
    if (movie) {
      const idx = room.selectedMovies.findIndex(m => m.id === movieId);
      if (idx >= 0) room.selectedMovies.splice(idx, 1);
      else room.selectedMovies.push(movie);
      io.to(code).emit('selection-update', { selectedMovies: room.selectedMovies, selectedCount: room.selectedMovies.length });
    }
  });

  socket.on('start-tournament', (code) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id || room.selectedMovies.length < 2) return;
    const shuffled = [...room.selectedMovies].sort(() => Math.random() - 0.5);
    room.bracket = createBracket(shuffled);
    room.currentRound = 0;
    room.currentMatch = 0;
    room.votes = {};
    room.phase = 'voting';
    io.to(code).emit('tournament-start', { bracket: room.bracket, currentRound: 0, currentMatch: 0, match: room.bracket[0][0] });
  });

  socket.on('vote', (data) => {
    const { code, choice } = data;
    const room = rooms[code];
    if (!room || room.phase !== 'voting') return;
    const key = `${room.currentRound}-${room.currentMatch}`;
    if (!room.votes[key]) room.votes[key] = {};
    const player = room.players[socket.id];
    room.votes[key][socket.id] = { playerName: player.name, avatar: player.avatar, choice };
    io.to(code).emit('vote-update', { votes: room.votes[key], playersVoted: Object.keys(room.votes[key]).length, totalPlayers: Object.keys(room.players).length });
  });

  socket.on('advance-match', (code) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    const currentMatch = room.bracket[room.currentRound][room.currentMatch];
    const key = `${room.currentRound}-${room.currentMatch}`;
    const votes = room.votes[key] || {};
    const m1Votes = Object.values(votes).filter(v => v.choice === 0).length;
    const m2Votes = Object.values(votes).filter(v => v.choice === 1).length;
    const winner = m1Votes >= m2Votes ? currentMatch.m1 : currentMatch.m2;
    room.voteHistory.push({ round: room.currentRound, match: room.currentMatch, m1: currentMatch.m1.title, m2: currentMatch.m2.title, winner: winner.title, votes });
    room.currentMatch++;
    if (room.currentMatch >= room.bracket[room.currentRound].length) {
      room.currentRound++;
      room.currentMatch = 0;
      if (room.currentRound >= room.bracket.length) {
        room.phase = 'results';
        io.to(code).emit('tournament-end', { winner, voteHistory: room.voteHistory });
        return;
      }
      for (let i = 0; i < room.bracket[room.currentRound - 1].length; i++) {
        const voteKey = `${room.currentRound - 1}-${i}`;
        const m1V = Object.values(room.votes[voteKey] || {}).filter(v => v.choice === 0).length;
        const m2V = Object.values(room.votes[voteKey] || {}).filter(v => v.choice === 1).length;
        const w = m1V >= m2V ? room.bracket[room.currentRound - 1][i].m1 : room.bracket[room.currentRound - 1][i].m2;
        const targetMatch = Math.floor(i / 2);
        if (i % 2 === 0) room.bracket[room.currentRound][targetMatch].m1 = w;
        else room.bracket[room.currentRound][targetMatch].m2 = w;
      }
    }
    const nextMatch = room.bracket[room.currentRound][room.currentMatch];
    io.to(code).emit('next-match', { match: nextMatch, currentRound: room.currentRound, currentMatch: room.currentMatch });
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      if (rooms[code].hostId === socket.id) delete rooms[code];
      else if (rooms[code].players[socket.id]) delete rooms[code].players[socket.id];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
