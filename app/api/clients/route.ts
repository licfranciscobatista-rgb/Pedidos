import { businessGet, businessSave } from "../_business";
export async function GET(request:Request){return businessGet(request,"clients");}
export async function POST(request:Request){return businessSave(request,"clients",true);}
export async function PUT(request:Request){return businessSave(request,"clients",false);}
