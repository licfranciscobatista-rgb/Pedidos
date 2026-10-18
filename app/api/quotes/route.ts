import { businessGet, businessSave } from "../_business";
export async function GET(request:Request){return businessGet(request,"quotes");}
export async function POST(request:Request){return businessSave(request,"quotes",true);}
export async function PUT(request:Request){return businessSave(request,"quotes",false);}
