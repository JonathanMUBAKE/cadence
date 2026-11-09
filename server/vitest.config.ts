import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Les tests existants se connectent par profil : le mode démo reste leur point d'entrée
    env: { CADENCE_DEMO: "1" },
    // Le hachage des mots de passe et le démarrage de la base embarquée prennent du temps sous charge
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
