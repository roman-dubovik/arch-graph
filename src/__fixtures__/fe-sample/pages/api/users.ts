// Pages Router API route — should NOT be treated as a FE page
export default function handler(req: any, res: any) {
    res.json({ users: [] });
}
