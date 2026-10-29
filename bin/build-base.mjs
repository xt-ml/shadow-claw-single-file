#!/usr/bin/env node

import fs from "fs";
import path from "path";

const __dirname = import.meta.dirname;
const file = path.join(__dirname, "../index.html");
const data = fs.readFileSync(file, "utf8");

fs.writeFileSync(
  file,
  data
    .split('<base href="/" />')
    .join('<base href="/shadow-claw-single-file/" />'),
);
