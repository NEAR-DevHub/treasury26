import axios from "axios";

export function isAxiosErrorWithStatus(
    error: unknown,
    statusCode: number,
): boolean {
    return axios.isAxiosError(error) && error.response?.status === statusCode;
}
