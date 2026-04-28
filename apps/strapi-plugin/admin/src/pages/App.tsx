import { Route, Routes } from "react-router-dom";
import HomePage from "./HomePage";

const App = () => (
  <Routes>
    <Route index element={<HomePage />} />
    <Route path="*" element={<HomePage />} />
  </Routes>
);

export { App };
export default App;
