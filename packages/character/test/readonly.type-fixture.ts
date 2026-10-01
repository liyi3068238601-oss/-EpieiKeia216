import { loadCharacter } from "../src/index.js";
import type { CharacterAsset } from "../src/index.js";
const persona: CharacterAsset = loadCharacter("assets/character");
const text: string = persona.fields.identity.text;
void text;
// @ts-expect-error loaded identity is read-only
persona.id = "xiadie";
// @ts-expect-error nested text is read-only
persona.fields.identity.text = "replacement";
// @ts-expect-error provenance is read-only
persona.fields.identity.source.sha256 = "unapproved";
// @ts-expect-error the loaded snapshot has no file-write method
persona.write("replacement");
