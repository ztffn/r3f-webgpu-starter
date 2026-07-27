import { useState } from "react";
import { Loader } from "@react-three/drei";
import { GameCanvas } from "./components/GameCanvas";
import { Overlay } from "./components/Overlay";
import { DF2Scene } from "./df2/DF2Scene";

export default function App() {
  const [wireframe, setWireframe] = useState(false);

  return (
    <>
      <Overlay wireframe={wireframe} setWireframe={setWireframe} />

      <Loader />

      <GameCanvas>
        <DF2Scene wireframe={wireframe} />
      </GameCanvas>
    </>
  );
}
