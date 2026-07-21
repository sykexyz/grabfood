import { Router, type IRouter } from "express";
import healthRouter from "./health";
import visitsRouter from "./visits";

const router: IRouter = Router();

router.use(healthRouter);
router.use(visitsRouter);

export default router;
